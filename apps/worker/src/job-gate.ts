/**
 * Per-job-name async concurrency gate for the BullMQ worker.
 *
 * BullMQ accepts a single `concurrency` for the whole queue, so a worker with
 * `maxConcurrency = 4` would otherwise pull and run four `concurrency: 1`
 * jobs (such as `sharp` image resizing or `system.dispatchEffects`) at once.
 * Gating each `job.name` inside the processor honours per-job `concurrency`
 * without splitting queues.
 */
export interface KeyedGate {
  run<T>(key: string, limit: number, fn: () => Promise<T>): Promise<T>;
  activeCount(key: string): number;
}

export function createKeyedGate(): KeyedGate {
  const buckets = new Map<string, { active: number; waiters: Array<() => void> }>();

  return {
    async run<T>(key: string, limit: number, fn: () => Promise<T>): Promise<T> {
      const cap = Math.max(1, Math.floor(limit));
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { active: 0, waiters: [] };
        buckets.set(key, bucket);
      }

      if (bucket.active >= cap) {
        await new Promise<void>((resolve) => {
          bucket.waiters.push(resolve);
        });
      } else {
        bucket.active += 1;
      }

      try {
        return await fn();
      } finally {
        const next = bucket.waiters.shift();
        if (next) {
          // Hand the active slot directly to the waiter so a caller arriving
          // before the waiter's microtask resumes cannot exceed `cap`.
          next();
        } else {
          bucket.active -= 1;
          if (bucket.active === 0) buckets.delete(key);
        }
      }
    },

    activeCount(key: string): number {
      return buckets.get(key)?.active ?? 0;
    },
  };
}
