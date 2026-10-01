import type { Tx } from '@shop/db';
import type { Ctx } from '../kernel/context';
import { recordEffect } from '../effects/index';
import { groupbuyConfig } from './groupbuy.config';
import { requestAutoRefund } from './groupbuy.order';
import * as repo from './groupbuy.repo';

/**
 * What happens when a team runs out of time.
 *
 * A team that did not fill fails, and every paid member is refunded. There is
 * no 虚拟成团: the shop decided (2026-09-23) never to invent members, because
 * on the mini-program a filled-by-nobody team reads as a fake transaction.
 * An empty team (nobody paid) is cancelled.
 *
 * Two entry points, on purpose:
 *
 *  - `settleGroup` handles exactly one team and is what the delayed
 *    `groupbuy.expire` effect calls, so a team settles the second it expires
 *    rather than up to a sweep interval later;
 *  - `settleExpiredGroups` is the repeatable sweep, which exists because a
 *    delayed delivery can be late or lost and because an effect parked after
 *    eight failures stops trying. It is the belt to the timer's braces.
 *
 * Both are idempotent: `failGroup` and `cancelEmptyGroup` carry
 * `status = 'forming'` in their `WHERE`, so the second caller changes nothing.
 */

export interface SettleResult {
  groupId: number;
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'unchanged';
  /** Orders a refund was requested for. */
  refunds: number;
}

/**
 * Settles one expired team.
 *
 * The group row is locked first because the decision spans the group, its
 * members and the activity's stock ledger; `takeSeat` from a payment landing at
 * the same instant blocks on that lock and then loses its `expires_at > now`
 * guard, which is exactly the "join vs expiry" race this domain has to win
 * deterministically.
 */
export async function settleGroup(ctx: Ctx, groupId: number): Promise<SettleResult> {
  const now = ctx.clock.now();

  return ctx.withTx(async (tx) => {
    const group = await repo.lockGroup(tx, groupId);
    if (!group || group.status !== 'forming') {
      return { groupId, outcome: 'unchanged' as const, refunds: 0 };
    }
    if (group.expiresAt.getTime() > now.getTime()) {
      return { groupId, outcome: 'unchanged' as const, refunds: 0 };
    }

    // Nobody ever paid: there is nothing to refund.
    if (group.seatsTaken === 0) {
      const cancelled = await repo.cancelEmptyGroup(tx, { groupId, now });
      return {
        groupId,
        outcome: cancelled.won ? ('cancelled' as const) : ('unchanged' as const),
        refunds: 0,
      };
    }

    const failed = await repo.failGroup(tx, { groupId, now });
    if (!failed.won) return { groupId, outcome: 'unchanged' as const, refunds: 0 };

    // The members stay `joined` and their stock stays committed: the ledgers
    // move back when the refund actually lands, through `onOrderRefunded`.
    // Marking them refunded here would claim money had moved when it had not.
    const refunds = await requestRefundsFor(tx, ctx, groupId);
    await recordEffect(tx, ctx, {
      scope: 'groupbuy',
      scopeId: String(groupId),
      eventType: 'groupbuy.settle',
      payload: { groupId: String(groupId), outcome: 'failed', virtual: false },
    });
    return { groupId, outcome: 'failed' as const, refunds };
  });
}

async function requestRefundsFor(tx: Tx, ctx: Ctx, groupId: number): Promise<number> {
  const members = await repo.listPaidMembers(tx, groupId);
  for (const member of members) {
    await requestAutoRefund(tx, ctx, {
      orderId: member.orderId,
      groupId,
      reason: 'group_failed',
    });
  }
  return members.length;
}

export interface SweepReport {
  scanned: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  refunds: number;
}

/**
 * RISK-D-014: an `active` campaign whose 结束时间 has passed becomes `ended`, as presale's
 * window sweep does, so the admin list says 已结束 and the status filter finds it. The
 * storefront does not wait for this: its list and checkout already test the window. Teams
 * still forming run out their own clock. One transaction per campaign, conditional on
 * `status = 'active' AND end_at <= now`, so a second sweep or an operator pressing 结束 at
 * the same moment converge.
 */
export async function closeEndedActivities(ctx: Ctx): Promise<{ scanned: number; closed: number }> {
  const config = await ctx.config.get(groupbuyConfig);
  const now = ctx.clock.now();
  const ids = await repo.findClosableActivityIds(ctx.db, {
    now,
    limit: config.groupExpirySweepLimit,
  });
  let closed = 0;
  for (const id of ids) {
    const result = await ctx.withTx((tx) => repo.closeActivity(tx, { id, now }));
    if (result.won) closed += 1;
  }
  return { scanned: ids.length, closed };
}

/**
 * The repeatable sweep. Reads `groupbuy_groups_expiry_idx` and settles each
 * team in its own transaction, so one stuck group cannot hold the others.
 */
export async function settleExpiredGroups(ctx: Ctx): Promise<SweepReport> {
  const config = await ctx.config.get(groupbuyConfig);
  const ids = await repo.findExpiredGroupIds(ctx.db, {
    now: ctx.clock.now(),
    limit: config.groupExpirySweepLimit,
  });

  const report: SweepReport = {
    scanned: ids.length,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    refunds: 0,
  };
  for (const id of ids) {
    const result = await settleGroup(ctx, id);
    report.refunds += result.refunds;
    if (result.outcome === 'succeeded') report.succeeded += 1;
    else if (result.outcome === 'failed') report.failed += 1;
    else if (result.outcome === 'cancelled') report.cancelled += 1;
  }
  if (report.scanned > 0) {
    ctx.logger.info({ ...report }, 'groupbuy: settled expired groups');
  }
  return report;
}
