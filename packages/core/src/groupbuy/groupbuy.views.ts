import type { Ctx } from '../kernel/context';
import * as repo from './groupbuy.repo';

/**
 * 拼团活动浏览量, folded from a Redis hash by the worker.
 *
 * Bumping `groupbuy_activities.views` synchronously inside `detail()` — and
 * previously on every ordinary product page via `groupbuy.product.ts` —
 * puts every viewer in a queue on the activity row lock. Instead `detail()`
 * records `HINCRBY` in Redis (best-effort: a Redis hiccup never breaks the
 * storefront) and the worker drains and folds pending increments once a
 * minute in a single batched `UPDATE`.
 */

export const ACTIVITY_VIEWS_PENDING_KEY = 'groupbuy:views:pending';

const DRAIN_LUA = `
local entries = redis.call('HGETALL', KEYS[1])
if #entries > 0 then
  redis.call('DEL', KEYS[1])
end
return entries
`;

export async function recordActivityView(ctx: Ctx, activityId: number): Promise<void> {
  try {
    await ctx.redis.hincrby(ACTIVITY_VIEWS_PENDING_KEY, String(activityId), 1);
  } catch (error) {
    ctx.logger.warn(
      { err: error, activityId, key: ACTIVITY_VIEWS_PENDING_KEY },
      'groupbuy: record activity view failed',
    );
  }
}

export async function foldActivityViews(ctx: Ctx): Promise<{ activities: number; views: number }> {
  const raw = (await ctx.redis.eval(DRAIN_LUA, 1, ACTIVITY_VIEWS_PENDING_KEY)) as string[];
  if (!Array.isArray(raw) || raw.length === 0) return { activities: 0, views: 0 };

  const entries: { activityId: number; delta: number }[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const activityId = Number(raw[index]);
    const delta = Number(raw[index + 1]);
    if (
      Number.isSafeInteger(activityId) &&
      activityId > 0 &&
      Number.isSafeInteger(delta) &&
      delta > 0
    ) {
      entries.push({ activityId, delta });
    }
  }
  if (entries.length === 0) return { activities: 0, views: 0 };

  try {
    return await ctx.withTx((tx) => repo.foldActivityViews(tx, entries));
  } catch (error) {
    // Restore drained counts back to Redis so a transient DB error never loses them.
    const pipeline = ctx.redis.pipeline();
    for (const entry of entries) {
      pipeline.hincrby(ACTIVITY_VIEWS_PENDING_KEY, String(entry.activityId), entry.delta);
    }
    await pipeline.exec().catch(() => undefined);
    throw error;
  }
}
