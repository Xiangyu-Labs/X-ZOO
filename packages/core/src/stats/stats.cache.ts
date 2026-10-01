import type { Ctx } from '../kernel/context';
import { statsConfig } from './stats.config';

/**
 * The 60-second block cache.
 *
 * Every statistics block is a handful of aggregate scans over the order
 * tables, and the pages poll: the dashboard is left open on a wall screen, and
 * four operators watching a sale ask the same question within the same second.
 * One minute of Redis turns that into one query set per minute per window.
 *
 * Three properties matter more than the hit rate:
 *
 * 1. **A cache miss is the only failure mode.** If Redis is down, unreachable
 *    or full, the block is computed and returned; the error is logged at
 *    `warn` and never reaches the operator. A statistics page that 500s
 *    because a cache is unwell is worse than a slow one.
 * 2. **`generatedAt` is inside the cached value**, so a stale block says so.
 *    Recomputing the timestamp on the way out would make a minute-old number
 *    claim to be current.
 * 3. **The key carries the window**, not "today": a chart of last week and a
 *    chart of last month are different entries, and nothing has to be
 *    invalidated when the day rolls over — the key simply changes.
 *
 * Nothing invalidates these entries on a write, because writes happen in other
 * domains and a minute of lag is the documented contract of the screen.
 */

const PREFIX = 'stats:';

export async function cached<T>(ctx: Ctx, key: string, load: () => Promise<T>): Promise<T> {
  const { cacheSeconds } = await ctx.config.get(statsConfig);
  if (cacheSeconds <= 0) return load();

  const redisKey = `${PREFIX}${key}`;
  try {
    const hit = await ctx.redis.get(redisKey);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch (error) {
    ctx.logger.warn({ err: error, key: redisKey }, 'stats: cache read failed');
  }

  const value = await load();

  try {
    await ctx.redis.set(redisKey, JSON.stringify(value), 'EX', cacheSeconds);
  } catch (error) {
    ctx.logger.warn({ err: error, key: redisKey }, 'stats: cache write failed');
  }
  return value;
}

/**
 * Drops every cached block. Only the tests and a future "recompute now" button
 * need it — `SCAN`, never `KEYS`, because this runs against the production
 * Redis that also holds sessions and queues.
 */
export async function clearStatsCache(ctx: Ctx): Promise<number> {
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await ctx.redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) removed += await ctx.redis.del(...keys);
  } while (cursor !== '0');
  return removed;
}
