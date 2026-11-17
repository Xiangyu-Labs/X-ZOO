import { describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../kernel/context';
import {
  ACTIVITY_VIEWS_PENDING_KEY,
  foldActivityViews,
  recordActivityView,
} from './groupbuy.views';

function makeFakeRedis(initial: Record<string, number> = {}) {
  const hash = new Map<string, number>(Object.entries(initial));
  const redis = {
    hincrby: vi.fn(async (_key: string, field: string, by: number) => {
      const next = (hash.get(field) ?? 0) + by;
      hash.set(field, next);
      return next;
    }),
    eval: vi.fn(async (_script: string, _keysCount: number, _key: string) => {
      const out: string[] = [];
      for (const [k, v] of hash) out.push(k, String(v));
      hash.clear();
      return out;
    }),
    pipeline: vi.fn(() => {
      const ops: Array<[string, number]> = [];
      return {
        hincrby(_key: string, field: string, by: number) {
          ops.push([field, by]);
          return this;
        },
        exec: vi.fn(async () => {
          for (const [field, by] of ops) {
            hash.set(field, (hash.get(field) ?? 0) + by);
          }
          return [];
        }),
      };
    }),
    snapshot: () => Object.fromEntries(hash),
  };
  return redis;
}

function makeCtx(
  redis: ReturnType<typeof makeFakeRedis>,
  executeImpl?: () => Promise<unknown>,
): Ctx {
  const tx = {
    execute: vi.fn(
      executeImpl ??
        (async () => ({
          rows: [{ activities: 2, views: 3 }],
        })),
    ),
  };
  return {
    redis: redis as unknown as Ctx['redis'],
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Ctx['logger'],
    withTx: vi.fn(async (fn: (tx: never) => Promise<unknown>) => fn(tx as never)),
  } as unknown as Ctx;
}

describe('groupbuy activity view buffering & folding', () => {
  it('records view increments into Redis and never throws on Redis errors', async () => {
    const redis = makeFakeRedis();
    const ctx = makeCtx(redis);
    await recordActivityView(ctx, 10);
    await recordActivityView(ctx, 10);
    await recordActivityView(ctx, 20);
    expect(redis.hincrby).toHaveBeenCalledWith(ACTIVITY_VIEWS_PENDING_KEY, '10', 1);
    expect(redis.snapshot()).toEqual({ '10': 2, '20': 1 });

    redis.hincrby.mockRejectedValueOnce(new Error('redis down'));
    await expect(recordActivityView(ctx, 10)).resolves.toBeUndefined();
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('drains pending views and folds them in one transaction', async () => {
    const redis = makeFakeRedis({ '10': 2, '20': 1 });
    const ctx = makeCtx(redis);
    expect(await foldActivityViews(ctx)).toEqual({ activities: 2, views: 3 });
    expect(redis.snapshot()).toEqual({});
    expect(await foldActivityViews(ctx)).toEqual({ activities: 0, views: 0 });
  });

  it('restores drained counts back to Redis when the DB write fails', async () => {
    const redis = makeFakeRedis({ '10': 2, '20': 1 });
    const ctx = makeCtx(redis, async () => {
      throw new Error('db timeout');
    });
    await expect(foldActivityViews(ctx)).rejects.toThrow('db timeout');
    expect(redis.snapshot()).toEqual({ '10': 2, '20': 1 });
  });
});
