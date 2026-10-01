import { describe, expect, it, vi } from 'vitest';
import {
  createJobHeartbeat,
  JOB_HEARTBEAT_KEY,
  JOB_HEARTBEAT_MIN_INTERVAL_MS,
  JOB_HEARTBEAT_TTL_MS,
} from './job-heartbeat';

function harness(fail = false) {
  let now = 1_000_000;
  const set = vi.fn(async () => {
    if (fail) throw new Error('redis down');
    return 'OK';
  });
  const onError = vi.fn();
  const beat = createJobHeartbeat({ set, nowMs: () => now, onError });
  return {
    beat,
    set,
    onError,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('OPS-017 — the job heartbeat is written when a job completes', () => {
  it('writes the completion time with a TTL', async () => {
    const h = harness();
    await h.beat();
    expect(h.set).toHaveBeenCalledWith(JOB_HEARTBEAT_KEY, '1000000', 'PX', JOB_HEARTBEAT_TTL_MS);
  });

  it('writes at most once per interval, however many jobs complete', async () => {
    const h = harness();
    for (let i = 0; i < 50; i += 1) await h.beat();
    expect(h.set).toHaveBeenCalledTimes(1);
    h.advance(JOB_HEARTBEAT_MIN_INTERVAL_MS);
    await h.beat();
    expect(h.set).toHaveBeenCalledTimes(2);
  });

  it('never throws, and retries on the next completion after a failed write', async () => {
    const h = harness(true);
    await expect(h.beat()).resolves.toBeUndefined();
    await h.beat();
    expect(h.set).toHaveBeenCalledTimes(2);
    expect(h.onError).toHaveBeenCalledTimes(2);
  });
});
