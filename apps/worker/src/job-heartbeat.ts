/**
 * "The worker is finishing jobs", as a Redis key.
 *
 * `worker:heartbeat` (main.ts) is written by a timer. A timer keeps ticking
 * when BullMQ's consumer has lost its blocking connection, or when every slot
 * is wedged on a hung call, so a fresh loop beat says the process is alive,
 * not that anything is being done. This key is written only when a job
 * *completes*, and `/api/v1/readyz` requires both (apps/web/src/server/health.ts).
 *
 * `system.dispatchEffects` completes every five seconds and `system.heartbeat`
 * every minute, so on a healthy worker the key is seconds old. Writes are
 * throttled: a burst of fifty completions is one `SET`, not fifty.
 */

export const JOB_HEARTBEAT_KEY = 'worker:heartbeat:job';

/** At most one write per this many ms. */
export const JOB_HEARTBEAT_MIN_INTERVAL_MS = 5_000;

/**
 * Long enough that a stale key reads as *stale* rather than missing — both
 * fail readiness, but "stale" is the better clue — and short enough that a
 * worker gone for good leaves nothing behind for long.
 */
export const JOB_HEARTBEAT_TTL_MS = 15 * 60_000;

export interface JobHeartbeatDeps {
  set: (key: string, value: string, mode: 'PX', ttlMs: number) => Promise<unknown>;
  nowMs: () => number;
  onError: (error: unknown) => void;
}

/** Returns the function to call after each completed job. Never throws. */
export function createJobHeartbeat(deps: JobHeartbeatDeps): () => Promise<void> {
  let lastWriteMs = Number.NEGATIVE_INFINITY;
  return async () => {
    const now = deps.nowMs();
    if (now - lastWriteMs < JOB_HEARTBEAT_MIN_INTERVAL_MS) return;
    lastWriteMs = now;
    try {
      await deps.set(JOB_HEARTBEAT_KEY, String(now), 'PX', JOB_HEARTBEAT_TTL_MS);
    } catch (error) {
      // Try again on the next completion rather than in five seconds.
      lastWriteMs = Number.NEGATIVE_INFINITY;
      deps.onError(error);
    }
  };
}
