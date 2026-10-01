import { z } from 'zod';

/**
 * The queue *port*. `packages/core` enqueues through this interface and never
 * imports BullMQ, so a service can be unit-tested with `memoryQueue()` and the
 * worker app owns the only real connection.
 */

export interface EnqueueOptions {
  /** Milliseconds to wait before the job becomes runnable. */
  delay?: number;
  /**
   * Collapses duplicates: enqueueing the same key again while the first is
   * still pending is a no-op. Use it for "cancel this order in 30 minutes",
   * which must not queue twice when a user retries a submit.
   */
  dedupeKey?: string;
  /** Overrides the job's default attempt count. */
  attempts?: number;
  priority?: number;
}

export interface JobQueue {
  enqueue(jobName: string, payload: unknown, options?: EnqueueOptions): Promise<void>;
  /** Removes a pending job previously enqueued with this dedupe key. */
  cancel(dedupeKey: string): Promise<void>;
}

export interface RecordedJob {
  jobName: string;
  payload: unknown;
  options: EnqueueOptions;
}

/**
 * In-memory queue for unit tests and for the mock server. Records instead of
 * running, because a unit test asserts *that* a job was enqueued, and an
 * integration test runs the real worker.
 */
export function memoryQueue(): JobQueue & { jobs: RecordedJob[]; reset(): void } {
  const jobs: RecordedJob[] = [];
  return {
    jobs,
    reset: () => {
      jobs.length = 0;
    },
    async enqueue(jobName, payload, options = {}) {
      if (options.dedupeKey && jobs.some((j) => j.options.dedupeKey === options.dedupeKey)) return;
      jobs.push({ jobName, payload, options });
    },
    async cancel(dedupeKey) {
      const at = jobs.findIndex((j) => j.options.dedupeKey === dedupeKey);
      if (at >= 0) jobs.splice(at, 1);
    },
  };
}

/** Drops everything. For a container that must boot without Redis. */
export const noopQueue: JobQueue = {
  async enqueue() {},
  async cancel() {},
};

/**
 * Shared by `defineJob` in the worker and by anything that wants to validate a
 * payload before enqueueing it.
 */
export const jobEnvelope = z.object({
  /** Correlates the job's log lines with the request that scheduled it. */
  requestId: z.string().optional(),
});
export type JobEnvelope = z.infer<typeof jobEnvelope>;
