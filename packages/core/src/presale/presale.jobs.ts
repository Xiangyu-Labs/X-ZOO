import type { Ctx } from '../kernel/context';
import { recordEffect } from '../effects/index';
import { presaleConfig } from './presale.config';
import * as repo from './presale.repo';

/**
 * The sale window, opened and closed on time.
 *
 * Bounded, recorded, and with an "open" half as well as a "close" one, so a
 * campaign that is supposed to start on Friday starts on Friday rather than
 * whenever an operator remembers to press 上架.
 *
 * Two halves, and they are not symmetric, because the schema is not:
 *
 *  - **close** is a real state change. An `active` campaign whose `end_at` has
 *    passed becomes `ended`, which takes it out of the storefront list *and*
 *    out of the admin's "running now" filter. It is a conditional update
 *    carrying `status = 'active' AND end_at <= now`, so a second sweep, a
 *    second worker, or an operator pressing 结束 at the same moment all
 *    converge on one outcome.
 *  - **open** changes no row. There is no `scheduled` status to leave, and the
 *    storefront list already filters on `start_at <= now < end_at`, so a
 *    campaign becomes buyable by itself at the second its window opens — which
 *    is more timely than any sweep could be. What the open half does is record
 *    `presale.opened` once per campaign, so a notification or a channel refresh
 *    has something to hang off. `UNIQUE (scope, scope_id, event_type)` on the
 *    effects ledger is the exactly-once; the config's lookback only keeps the
 *    query bounded.
 *
 * Both are safe to run as often as you like and safe to run twice at once.
 */

export const PRESALE_WINDOW_JOB = 'presale.sweepWindows';

export interface WindowSweepReport {
  /** Campaigns examined by the close half. */
  scanned: number;
  /** Campaigns this pass moved to `ended`. */
  closed: number;
  /** Campaigns whose opening this pass recorded for the first time. */
  opened: number;
}

/**
 * Closes every campaign whose window has passed.
 *
 * Each campaign is closed in its own transaction, so one stuck row cannot hold
 * the others, and the effect is recorded in the same transaction as the status
 * move — if the transaction rolls back, neither happened.
 */
export async function closeEndedActivities(ctx: Ctx): Promise<{ scanned: number; closed: number }> {
  const config = await ctx.config.get(presaleConfig);
  const now = ctx.clock.now();
  const ids = await repo.findClosableActivityIds(ctx.db, {
    now,
    limit: config.windowSweepLimit,
  });

  let closed = 0;
  for (const id of ids) {
    const won = await ctx.withTx(async (tx) => {
      const result = await repo.closeActivity(tx, { id, now });
      if (!result.won) return false;
      await recordEffect(tx, ctx, {
        scope: 'presale',
        scopeId: String(id),
        eventType: 'presale.closed',
        payload: { activityId: String(id), at: now.toISOString() },
      });
      return true;
    });
    if (won) closed += 1;
  }
  return { scanned: ids.length, closed };
}

/**
 * Records the opening of every campaign whose window has just started.
 *
 * `recordEffect` returns `false` when the row was already there, so the count
 * is genuinely "campaigns that opened since the last pass" rather than
 * "campaigns currently open", which is what makes this safe to run every
 * minute.
 */
export async function recordOpenedActivities(ctx: Ctx): Promise<number> {
  const config = await ctx.config.get(presaleConfig);
  const now = ctx.clock.now();
  const since = new Date(now.getTime() - config.windowOpenLookbackHours * 3_600_000);
  const ids = await repo.findOpenedActivityIds(ctx.db, {
    since,
    now,
    limit: config.windowSweepLimit,
  });

  let opened = 0;
  for (const id of ids) {
    const first = await ctx.withTx((tx) =>
      recordEffect(tx, ctx, {
        scope: 'presale',
        scopeId: String(id),
        eventType: 'presale.opened',
        payload: { activityId: String(id), at: now.toISOString() },
      }),
    );
    if (first) opened += 1;
  }
  return opened;
}

/** Both halves, for the one repeatable job the worker runs. */
export async function sweepPresaleWindows(ctx: Ctx): Promise<WindowSweepReport> {
  const opened = await recordOpenedActivities(ctx);
  const { scanned, closed } = await closeEndedActivities(ctx);
  const report: WindowSweepReport = { scanned, closed, opened };
  if (closed > 0 || opened > 0) {
    ctx.logger.info({ ...report }, 'presale: swept activity windows');
  }
  return report;
}
