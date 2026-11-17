import { describe, expect, it, vi } from 'vitest';

import { drainInBatches } from './drain';

describe('drainInBatches', () => {
  it('runs batches until one comes back short', async () => {
    const batch = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(40);
    expect(await drainInBatches(batch, { limit: 100 })).toBe(240);
    expect(batch).toHaveBeenCalledTimes(3);
  });

  it('stops after one batch when nothing is left', async () => {
    const batch = vi.fn<() => Promise<number>>().mockResolvedValue(0);
    expect(await drainInBatches(batch, { limit: 100 })).toBe(0);
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it('leaves a backlog bigger than maxBatches for the next run', async () => {
    const batch = vi.fn<() => Promise<number>>().mockResolvedValue(100);
    expect(await drainInBatches(batch, { limit: 100, maxBatches: 3 })).toBe(300);
    expect(batch).toHaveBeenCalledTimes(3);
  });
});
