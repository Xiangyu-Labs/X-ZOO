import { createBullQueue } from '@shop/core/kernel/queue-bullmq';
import Redis from 'ioredis';
import { indexJobs, JobPayloadError, parsePayload, type AnyJobDefinition } from './define-job';
import { loadEnv } from './env';

/**
 * `node /app/main.mjs enqueue <job> [<json payload>]`: puts one on-demand job
 * on the queue for the running worker, and exits.
 *
 * For the one-off jobs an operator starts by hand (the image-variant backfill)
 * — run inside the worker container, so it has the worker's `REDIS_URL` and
 * `QUEUE_NAME` and needs no port, route or credential of its own:
 *
 *     ./shop compose exec -T worker node /app/main.mjs enqueue storage.backfillImageVariants
 *
 * The work itself happens in the worker process, under its concurrency limit
 * and its memory cap, with its logging and failed-job record — not in this
 * short-lived process, which would share the container's memory with it.
 *
 * Only jobs without a schedule can be enqueued here: a scheduled job already
 * runs on its own, and running it by hand is not what this is for.
 */

export type EnqueuePlan =
  { ok: true; jobName: string; payload: unknown } | { ok: false; message: string };

/** The job and its validated payload, or why the command line is refused. Pure. */
export function planEnqueue(
  args: readonly string[],
  jobs: readonly AnyJobDefinition[],
): EnqueuePlan {
  const [jobName, rawPayload, ...rest] = args;
  const onDemand = [...indexJobs(jobs).values()].filter((job) => !job.repeat);
  const usage = `用法: enqueue <job> [<JSON 载荷>]\n可入队的任务: ${onDemand
    .map((job) => job.name)
    .sort()
    .join(', ')}`;
  if (!jobName || rest.length > 0) return { ok: false, message: usage };

  const definition = indexJobs(jobs).get(jobName);
  if (!definition) return { ok: false, message: `没有任务 "${jobName}"\n${usage}` };
  if (definition.repeat) {
    return { ok: false, message: `"${jobName}" 是定时任务，会按计划自动运行，不能手动入队` };
  }

  let payload: unknown = {};
  if (rawPayload !== undefined) {
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      return { ok: false, message: `载荷不是合法的 JSON: ${rawPayload}` };
    }
  }
  try {
    // Validated here so a typo is refused at the prompt, not later in the worker.
    parsePayload(definition, payload);
  } catch (error) {
    if (error instanceof JobPayloadError) return { ok: false, message: error.message };
    throw error;
  }
  // The raw payload is what goes on the queue: the worker applies the
  // schema's defaults itself when it runs the job.
  return { ok: true, jobName, payload };
}

/** Runs the command. Returns the process exit code. */
export async function enqueueCommand(
  args: readonly string[],
  jobs: readonly AnyJobDefinition[],
  out: { log: (line: string) => void; error: (line: string) => void } = console,
): Promise<number> {
  const plan = planEnqueue(args, jobs);
  if (!plan.ok) {
    out.error(plan.message);
    return 2;
  }
  const env = loadEnv();
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = createBullQueue({ connection, queueName: env.QUEUE_NAME });
  try {
    await queue.enqueue(plan.jobName, plan.payload);
    out.log(`已入队: ${plan.jobName} ${JSON.stringify(plan.payload)}`);
    return 0;
  } finally {
    await queue.close().catch(() => undefined);
    connection.disconnect();
  }
}
