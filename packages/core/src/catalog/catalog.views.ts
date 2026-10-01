import type { Ctx } from '../kernel/context';
import * as repo from './catalog.repo';

/**
 * 商品浏览量, folded from `product_events` by the worker.
 *
 * A product view is one `product_events` row — the record browse history and
 * the traffic report already read. `products.views`, the number on the admin
 * list and the product card, is a denormalised count of those rows. Bumping it
 * with `UPDATE products SET views = views + 1` on every detail request would
 * put every viewer of one product in a queue on that product's row lock. So the
 * request only inserts, and this folds the new rows in, one statement per
 * batch.
 *
 * **The watermark** is the last `product_events.id` folded, kept in Redis
 * (there is no table for it, and the counter does not deserve a migration).
 * A run claims its range by compare-and-set *before* it writes, and gives it
 * back if the write fails, so two runs never fold the same range: a crash in
 * between loses at most one batch of views rather than counting any twice.
 * A missing watermark (first run after deploy, or a Redis that lost it) starts
 * at the newest settled event, and so does one ahead of every event (the table
 * was restored or truncated): the rows before it were already counted by the
 * old per-request bump, or are lost, and this is a display counter — the
 * events themselves, which the reports read, are untouched.
 *
 * **The grace period.** Ids are handed out at insert, not at commit, so the
 * fold only reaches events at least `graceMs` old: a view whose transaction
 * is still open is never stepped over.
 */

export const VIEW_WATERMARK_KEY = 'catalog:views:folded-through';

export interface FoldViewsOptions {
  /** Event ids per statement. */
  batchSize?: number;
  /** Batches per run; the next run carries on. */
  maxBatches?: number;
  /** Only events at least this old (database clock) are folded. */
  graceMs?: number;
}

export interface FoldViewsReport {
  /** The watermark was missing and has just been set; nothing was folded. */
  initialised: boolean;
  batches: number;
  products: number;
  views: number;
  /** The watermark after the run. */
  through: number | null;
}

/** The newest event of any age. */
const newestEventId = (ctx: Ctx): Promise<number | null> => repo.lastSettledEventId(ctx.db, 0);

const CLAIM_LUA = `
local current = redis.call('GET', KEYS[1])
if current == false then return -1 end
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

export async function foldProductViews(
  ctx: Ctx,
  options: FoldViewsOptions = {},
): Promise<FoldViewsReport> {
  const batchSize = options.batchSize ?? 50_000;
  const maxBatches = options.maxBatches ?? 20;
  const graceMs = options.graceMs ?? 10_000;
  const report: FoldViewsReport = {
    initialised: false,
    batches: 0,
    products: 0,
    views: 0,
    through: null,
  };

  const settled = await repo.lastSettledEventId(ctx.db, graceMs);
  const stored = await ctx.redis.get(VIEW_WATERMARK_KEY);
  if (stored === null) {
    await ctx.redis.set(VIEW_WATERMARK_KEY, String(settled ?? 0), 'NX');
    return { ...report, initialised: true, through: settled ?? 0 };
  }

  let from = Number(stored);
  if (!Number.isSafeInteger(from) || from < 0 || from > ((await newestEventId(ctx)) ?? 0)) {
    // The watermark is ahead of every event there is: the table went back
    // (a restore, a truncate) or the key was garbage. Start again from here
    // rather than wait for the ids to catch up with it.
    const claimed = await ctx.redis.eval(
      CLAIM_LUA,
      1,
      VIEW_WATERMARK_KEY,
      stored,
      String(settled ?? 0),
    );
    return { ...report, initialised: claimed === 1, through: settled ?? 0 };
  }
  report.through = from;
  while (settled !== null && from < settled && report.batches < maxBatches) {
    const through = Math.min(settled, from + batchSize);
    const claimed = await ctx.redis.eval(
      CLAIM_LUA,
      1,
      VIEW_WATERMARK_KEY,
      String(from),
      String(through),
    );
    // Another run moved the watermark (or it vanished): stop, it has this range.
    if (claimed !== 1) break;
    try {
      const folded = await ctx.withTx((tx) =>
        repo.foldViewEvents(tx, { afterId: from, throughId: through }),
      );
      report.products += folded.products;
      report.views += folded.views;
    } catch (error) {
      await ctx.redis.eval(CLAIM_LUA, 1, VIEW_WATERMARK_KEY, String(through), String(from));
      throw error;
    }
    report.batches += 1;
    from = through;
    report.through = from;
  }
  return report;
}
