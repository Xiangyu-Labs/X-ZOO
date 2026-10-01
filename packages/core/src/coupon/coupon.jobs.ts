import type { Ctx } from '../kernel/context';
import * as repo from './coupon.repo';

/**
 * The two housekeeping sweeps. They live in `core` (not in `apps/worker`)
 * because the worker job file must stay the three-line declaration that
 * `defineJob` is for, and because an integration test wants to call the sweep
 * without booting BullMQ.
 *
 * Both are batched and both are idempotent: the job runs them until a pass
 * changes nothing, so a backlog of a million rows drains without one statement
 * holding a lock for minutes.
 */

/** A pass big enough to matter, small enough that the UPDATE finishes fast. */
const BATCH = 500;

/** Safety valve: a runaway pass stops rather than looping until the lease expires. */
const MAX_PASSES = 40;

/**
 * Marks `unused` coupons whose `valid_to` has passed as `expired`.
 *
 * Nothing *depends* on this: every read filters on the window as well
 * (`listSpendableUserCoupons`, `redeemUserCoupon`), so an un-swept coupon is
 * already unusable. The sweep exists so the wallet's "已过期" tab and the admin
 * list tell the truth, and so `user_coupons_expiry_idx` stays small.
 *
 * It is a job rather than a sweep on read: sweeping opportunistically from a
 * wallet read would make one shopper opening their wallet write to every row in
 * the table.
 */
export async function expireOverdueCoupons(ctx: Ctx): Promise<number> {
  const now = ctx.clock.now();
  let total = 0;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const swept = await ctx.withTx((tx) => repo.expireOverdue(tx, { now, limit: BATCH }));
    total += swept;
    if (swept < BATCH) break;
  }
  return total;
}

/**
 * Disables `active` templates whose claim window has closed.
 *
 * Also belt-and-braces: `listClaimable` filters on `claim_to` too. Flipping the
 * status is what stops a closed campaign showing as 进行中 in the admin list.
 */
export async function disableClosedCampaigns(ctx: Ctx): Promise<number> {
  const now = ctx.clock.now();
  let total = 0;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const closed = await ctx.withTx((tx) => repo.disableClosedTemplates(tx, { now, limit: BATCH }));
    total += closed;
    if (closed < BATCH) break;
  }
  return total;
}
