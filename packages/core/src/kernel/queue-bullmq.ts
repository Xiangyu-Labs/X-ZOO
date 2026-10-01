import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import type { EnqueueOptions, JobQueue } from './queue';

/**
 * The BullMQ adapter for the `JobQueue` port.
 *
 * It lives in the kernel rather than in `apps/worker` because the *web* app is
 * the main producer — `apps/web` must be able to schedule "cancel this order in
 * 30 minutes" without depending on the worker package. The worker owns the
 * consumer side.
 *
 * `dedupeKey` maps onto BullMQ's `jobId`: adding a job with an id that already
 * exists is a documented no-op, which is exactly the semantics the port
 * promises.
 *
 * The port's key is an opaque string; BullMQ's id is not (see `toJobId`). The
 * translation lives here and nowhere else, so a producer may write
 * `order-auto-cancel:42` and never learn what the broker thinks of colons.
 */

/**
 * BullMQ refuses a custom id that contains `:` (it is the separator of its own
 * key space; `Job.validateOptions` throws `Custom Id cannot contain :`) and one
 * that parses as an integer. Every producer in this repository builds
 * `name:id`, so without this mapping every checkout, shipment and receipt
 * confirmation would answer 500 on a real Redis after its transaction had
 * already committed. `__` never appears in a producer's key, so the mapping is
 * injective for the keys that exist.
 */
export function toJobId(dedupeKey: string): string {
  const mapped = dedupeKey.replaceAll(':', '__');
  return /^\d+$/.test(mapped) ? `k__${mapped}` : mapped;
}

export const DEFAULT_QUEUE_NAME = 'shop';

export interface BullQueueOptions {
  connection: Redis;
  queueName?: string;
  defaultAttempts?: number;
}

export function createBullQueue(options: BullQueueOptions): JobQueue & { close(): Promise<void> } {
  const queue = new Queue(options.queueName ?? DEFAULT_QUEUE_NAME, {
    connection: options.connection,
    defaultJobOptions: {
      attempts: options.defaultAttempts ?? 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 3600, count: 1000 },
      // Keep failures around long enough for an operator to look at them, but
      // not without bound: Redis runs `noeviction`, and an outage that fails a
      // thousand per-order jobs must not fill it (exhausted ones are also in
      // `failed_jobs`).
      removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
    },
  });

  return {
    async enqueue(jobName: string, payload: unknown, enqueueOptions: EnqueueOptions = {}) {
      await queue.add(jobName, payload, {
        ...(enqueueOptions.delay !== undefined ? { delay: enqueueOptions.delay } : {}),
        ...(enqueueOptions.dedupeKey ? { jobId: toJobId(enqueueOptions.dedupeKey) } : {}),
        ...(enqueueOptions.attempts !== undefined ? { attempts: enqueueOptions.attempts } : {}),
        ...(enqueueOptions.priority !== undefined ? { priority: enqueueOptions.priority } : {}),
      });
    },
    async cancel(dedupeKey: string) {
      const job = await queue.getJob(toJobId(dedupeKey));
      // Only a job that has not started can be withdrawn; an active one must
      // make itself a no-op instead.
      if (job) await job.remove().catch(() => undefined);
    },
    close: () => queue.close(),
  };
}
