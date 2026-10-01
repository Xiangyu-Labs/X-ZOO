import { Queue, Worker, type Job } from 'bullmq';
import { buildWorkerContainer, type WorkerContainer } from './container';
import { enqueueCommand } from './enqueue';
import { exhaustedSummary, NO_HANDLER_SUMMARY } from './failed-job';
import { HEARTBEAT_KEY } from './env';
import { indexJobs, parsePayload, type AnyJobDefinition } from './define-job';
import { createJobHeartbeat } from './job-heartbeat';
import { allJobs } from './jobs.gen';
import { recordFailedJob } from '@shop/core/kernel';

/**
 * The worker process.
 *
 * One container for queued and scheduled work: BullMQ handles both on-demand
 * jobs and repeatable schedules, and the repeatable schedule is *declared* by
 * each job rather than configured somewhere else.
 *
 * Two operational promises:
 *  - **liveness**: `worker:heartbeat` is refreshed every `HEARTBEAT_INTERVAL_MS`
 *    with a TTL of four intervals, so the container healthcheck is a single
 *    `redis-cli exists`. A wedged event loop stops refreshing it. And
 *    `worker:heartbeat:job` is written when a job *completes*
 *    (`job-heartbeat.ts`), so readiness can tell a live process from a worker
 *    that is actually consuming the queue.
 *  - **graceful shutdown**: SIGTERM stops accepting new jobs and waits up to
 *    `SHUTDOWN_TIMEOUT_MS` for the in-flight ones, so a redeploy does not tear
 *    a half-finished payment notification in two.
 */

export async function start(): Promise<{ stop: () => Promise<void>; container: WorkerContainer }> {
  const container = buildWorkerContainer();
  const { ctx, env, logger } = { ...container, logger: container.ctx.logger };

  const jobs = indexJobs(allJobs);
  logger.info({ jobs: [...jobs.keys()] }, 'worker starting');

  // -- repeatable schedules -------------------------------------------------
  const queue = new Queue(env.QUEUE_NAME, { connection: container.queueRedis });
  await syncRepeatables(queue, jobs, logger);

  // -- the worker -----------------------------------------------------------
  const maxConcurrency = Math.max(
    env.WORKER_CONCURRENCY,
    ...[...jobs.values()].map((job) => job.concurrency ?? 1),
  );

  const worker = new Worker(
    env.QUEUE_NAME,
    async (job: Job) => {
      const definition = jobs.get(job.name);
      if (!definition) {
        // A job from a newer deployment, or a retired one. Do not retry it
        // forever; record it and move on.
        logger.error({ jobName: job.name, jobId: job.id }, 'no handler for job');
        await recordFailedJob(ctx.db, {
          queue: env.QUEUE_NAME,
          jobName: job.name,
          jobId: job.id ?? null,
          payload: job.data,
          error: 'no handler registered',
          summary: NO_HANDLER_SUMMARY,
          attempts: job.attemptsMade,
          now: ctx.clock.now(),
        });
        return;
      }
      const payload = parsePayload(definition, job.data);
      const jobCtx = ctx.as(ctx.actor);
      const startedAt = ctx.clock.nowMs();
      await definition.handler(jobCtx, payload);
      logger.debug(
        { jobName: job.name, jobId: job.id, durationMs: ctx.clock.nowMs() - startedAt },
        'job done',
      );
    },
    {
      connection: container.queueRedis,
      concurrency: maxConcurrency,
      // Long enough for a slow third party, short enough that a wedged job is
      // retried the same day.
      lockDuration: 120_000,
    },
  );

  worker.on('failed', (job, error) => {
    logger.error(
      { jobName: job?.name, jobId: job?.id, attempt: job?.attemptsMade, err: error },
      'job failed',
    );
    const exhausted = job && job.attemptsMade >= (job.opts.attempts ?? 1);
    if (job && exhausted) {
      void recordFailedJob(ctx.db, {
        queue: env.QUEUE_NAME,
        jobName: job.name,
        jobId: job.id ?? null,
        payload: job.data,
        error: error instanceof Error ? error.message : String(error),
        summary: exhaustedSummary(error, job.attemptsMade),
        attempts: job.attemptsMade,
        now: ctx.clock.now(),
      }).catch((writeError: unknown) => {
        logger.error({ err: writeError }, 'could not record a failed job');
      });
    }
  });

  worker.on('error', (error) => {
    logger.error({ err: error }, 'worker error');
  });

  const jobDone = createJobHeartbeat({
    set: (key, value, mode, ttlMs) => container.redis.set(key, value, mode, ttlMs),
    nowMs: () => ctx.clock.nowMs(),
    onError: (error) => logger.warn({ err: error }, 'job heartbeat write failed'),
  });
  worker.on('completed', () => {
    void jobDone();
  });

  // -- heartbeat ------------------------------------------------------------
  const beat = async () => {
    try {
      await container.redis.set(
        HEARTBEAT_KEY,
        String(ctx.clock.nowMs()),
        'PX',
        env.HEARTBEAT_INTERVAL_MS * 4,
      );
    } catch (error) {
      logger.warn({ err: error }, 'heartbeat write failed');
    }
  };
  await beat();
  const heartbeat = setInterval(() => void beat(), env.HEARTBEAT_INTERVAL_MS);
  // Do not hold the process open for the timer alone.
  heartbeat.unref();

  logger.info({ concurrency: maxConcurrency, queue: env.QUEUE_NAME }, 'worker ready');

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);

    // Drop the liveness key before draining, not after. Draining can take the
    // full SHUTDOWN_TIMEOUT_MS, and a worker that has stopped accepting jobs
    // should stop looking healthy immediately — otherwise the orchestrator
    // keeps routing to a container that is on its way out.
    try {
      await container.redis.del(HEARTBEAT_KEY);
    } catch (error) {
      logger.warn({ err: error }, 'could not clear the heartbeat key');
    }

    logger.info('worker stopping, waiting for in-flight jobs');
    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        logger.warn('shutdown timed out, forcing');
        resolve();
      }, env.SHUTDOWN_TIMEOUT_MS).unref(),
    );
    await Promise.race([worker.close(), timeout]);
    await queue.close().catch(() => undefined);
    await container.close();
    logger.info('worker stopped');
  };

  return { stop, container };
}

/**
 * Makes the queue's repeatable schedules match what the code declares.
 *
 * BullMQ keeps schedulers in Redis, so a job whose cron changed — or which was
 * deleted — would otherwise keep firing on the old schedule forever. Removing
 * the strays is the part everyone forgets.
 */
export async function syncRepeatables(
  queue: Queue,
  jobs: Map<string, AnyJobDefinition>,
  logger: { info: (obj: unknown, msg: string) => void },
): Promise<void> {
  const wanted = [...jobs.values()].filter((job) => job.repeat);

  const existing = await queue.getJobSchedulers();
  const wantedNames = new Set(wanted.map((job) => job.name));
  for (const scheduler of existing) {
    if (!wantedNames.has(scheduler.name ?? scheduler.key)) {
      await queue.removeJobScheduler(scheduler.key);
      logger.info({ key: scheduler.key }, 'removed a stale repeatable schedule');
    }
  }

  for (const job of wanted) {
    const repeat = job.repeat!;
    await queue.upsertJobScheduler(
      job.name,
      repeat.pattern ? { pattern: repeat.pattern, tz: 'Asia/Shanghai' } : { every: repeat.every! },
      {
        name: job.name,
        data: {},
        // Both bounded. A sweep that fails every five seconds during an outage
        // would otherwise pile its failed runs into a Redis that does not
        // evict (`noeviction`), until sessions cannot be written either. The
        // exhausted ones are in `failed_jobs` already (the `failed` handler).
        opts: {
          attempts: job.attempts ?? 3,
          removeOnComplete: { count: 100 },
          removeOnFail: { age: 24 * 3600, count: 200 },
        },
      },
    );
  }
  logger.info({ scheduled: wanted.map((job) => job.name) }, 'repeatable schedules synced');
}

// Only run when executed directly, so tests can import `start`.
const isEntry = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isEntry && process.argv[2] === 'enqueue') {
  // `node main.mjs enqueue <job> [payload]`: an operator's one-off, not a worker.
  process.exit(await enqueueCommand(process.argv.slice(3), allJobs));
} else if (isEntry) {
  const { stop } = await start();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void stop().then(() => process.exit(0));
    });
  }
}
