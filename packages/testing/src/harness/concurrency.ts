/**
 * `runConcurrently` — the tool `docs/conventions.md` demands for every
 * conditional state change: "Every conditional state change ships a concurrency
 * test using `runConcurrently` from `@shop/testing`."
 *
 * The point is the *barrier*. Starting N promises in a loop does not make them
 * race: the first one is usually several event-loop turns ahead by the time the
 * last is created, so a read-then-write bug happily passes. Here every worker
 * blocks on one shared promise and they are all released in the same tick, so
 * they genuinely collide on the row.
 */

export interface ConcurrentOutcome<T> {
  index: number;
  status: 'fulfilled' | 'rejected';
  value?: T;
  reason?: unknown;
  /** Milliseconds from the barrier release to settling. */
  durationMs: number;
}

export interface ConcurrentReport<T> {
  results: ConcurrentOutcome<T>[];
  fulfilled: T[];
  rejected: unknown[];
  /** Convenience for the common `expect(report.winners).toBe(1)` assertion. */
  winners: number;
  losers: number;
}

export interface RunConcurrentlyOptions<T> {
  /**
   * Classifies a fulfilled result as a "win". Defaults to truthy — for a
   * conditional update, return `result.won`.
   */
  isWinner?: (value: T) => boolean;
  /** Extra delay after the barrier, to widen a suspected window. */
  jitterMs?: number;
}

/**
 * Runs `fn(i)` `n` times, all released at the same moment, and returns every
 * settled outcome. Never throws: a concurrency test asserts on *how many*
 * callers won, so a rejection is data, not a failure.
 *
 * @example
 * const report = await runConcurrently(10, () => claimCoupon(ctx, couponId, userId));
 * expect(report.fulfilled).toHaveLength(1);
 * expect(report.rejected).toHaveLength(9);
 */
export async function runConcurrently<T>(
  n: number,
  fn: (index: number) => Promise<T>,
  options: RunConcurrentlyOptions<T> = {},
): Promise<ConcurrentReport<T>> {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('runConcurrently: n 必须是正整数');

  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  const tasks = Array.from({ length: n }, (_unused, index) =>
    (async (): Promise<ConcurrentOutcome<T>> => {
      await barrier;
      if (options.jitterMs) {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * options.jitterMs!));
      }
      const startedAt = performance.now();
      try {
        const value = await fn(index);
        return { index, status: 'fulfilled', value, durationMs: performance.now() - startedAt };
      } catch (reason) {
        return { index, status: 'rejected', reason, durationMs: performance.now() - startedAt };
      }
    })(),
  );

  // Let every task reach `await barrier` before releasing them.
  await Promise.resolve();
  release();

  const results = await Promise.all(tasks);
  const fulfilled = results.filter((r) => r.status === 'fulfilled').map((r) => r.value as T);
  const rejected = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
  const isWinner = options.isWinner ?? ((value: T) => Boolean(value));
  const winners = fulfilled.filter((value) => isWinner(value)).length;

  return { results, fulfilled, rejected, winners, losers: n - winners };
}

/**
 * Repeats a concurrency scenario. CI's soak runs each concurrency scenario 50
 * rounds; this is how a test spells that without a loop that hides which
 * round failed.
 */
export async function repeatConcurrently<T>(
  rounds: number,
  n: number,
  fn: (round: number, index: number) => Promise<T>,
  options: RunConcurrentlyOptions<T> = {},
): Promise<ConcurrentReport<T>[]> {
  const reports: ConcurrentReport<T>[] = [];
  for (let round = 0; round < rounds; round += 1) {
    reports.push(await runConcurrently(n, (index) => fn(round, index), options));
  }
  return reports;
}
