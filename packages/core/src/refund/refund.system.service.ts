import type { Tx } from '@shop/db';
import { recordEffect } from '../effects';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { generateOrderNo, toId } from '../kernel/ids';
import { Money } from '../kernel/money';
import { findPaidPaymentAttempt } from '../payment';
import * as repo from './refund.repo';
import { freightRefundable, lineRefundAmount, remainingCeiling } from './refund.rules';
import { refreshOrderRefundStatus } from './refund.service';
import { findSucceededRefund, listAutomaticRefunds } from './refund.system.repo';

/**
 * Money the shop owes without anybody having asked for it.
 *
 * `refund.service.ts` is the buyer's road: apply, wait for a review, and only
 * then does the gateway hear about it. A failed group buy is none of those
 * things — nobody applied, nobody should have to approve, and the goods never
 * left the warehouse — but it is still a refund, and the one thing that must
 * not happen is a second way to insert a `refunds` row. So this file goes
 * through the same repo, the same ceiling arithmetic, the same `refund.execute`
 * effect and the same settlement (`settleRefundSucceeded` → `onOrderRefunded`)
 * that an operator's 同意 does. What it skips is only the human.
 *
 * ## Why this is a separate file
 *
 * `refund.service.ts` is the buyer's road and already 1,000 lines; the shop's
 * road reads better on its own. Nothing here is duplicated logic that could
 * drift into a *different answer*: the two places that would have been shared —
 * the freight rule and the "take the units out of fulfilment" step — are each
 * three lines over the same pure helpers in `refund.rules.ts`, and both call
 * sites are asserted by tests.
 *
 * ## Idempotency
 *
 * Per `(orderId, reason)`, decided by a lookup under the order's own row lock
 * rather than by trusting the caller's effect ledger. The ledger's
 * `UNIQUE (scope, scope_id, event_type)` already makes the group-buy sweep
 * record one effect per member however many sweeps run; this second guard is
 * for the cases the ledger cannot see — a parked effect an operator re-drives,
 * a replayed job, or a presale expiry and a group-buy failure landing on one
 * order. A losing caller gets the existing refund's id and `created: false`.
 *
 * The partial unique index `refund_items(order_item_id) WHERE is_open` is the
 * backstop underneath: even if two callers somehow got past the lock, the
 * second insert is refused by PostgreSQL rather than opening a second refund on
 * the same line.
 */

const REFUND_NO_PREFIX = 'RF';
const OUT_REFUND_NO_PREFIX = 'R';

export type SystemRefundReason = 'groupbuy_failed' | 'presale_expired';

/**
 * The customer-facing reason, and the idempotency key.
 *
 * There is no column for "which automatic process opened this", so the reason
 * string carries it. It is written once and never edited, and the lookup
 * matches on it exactly — which is why these strings are constants here rather
 * than something a caller passes in.
 */
const SYSTEM_REASONS: Record<SystemRefundReason, string> = {
  groupbuy_failed: '拼团未成团，系统自动退款',
  presale_expired: '预售未成行，系统自动退款',
};

export interface SystemRefundInput {
  orderId: number;
  reason: SystemRefundReason;
  /**
   * Staff detail (which team, which campaign), kept as the refund's internal
   * remark. Not the explanation and not the timeline: those are what the
   * shopper reads, and the note names internal ids (REFUND-019).
   */
  note?: string | undefined;
}

export interface SystemRefundResult {
  refundId: number;
  /** `false` when this order already had the refund this call would have made. */
  created: boolean;
}

/**
 * Opens — and queues — a refund the shop owes by itself.
 *
 * Full amount of every unshipped line, plus the freight when nothing shipped at
 * all, capped by the cumulative ceiling so an order that was already partly
 * refunded by hand cannot be refunded past what it paid.
 *
 * Runs inside the caller's transaction, like every other cross-domain entry
 * point: the group-buy effect handler opens one transaction and this writes in
 * it, so a failure leaves no half-made refund. The gateway call is *not* here —
 * it is the `refund.execute` effect, exactly as it is for an approved request,
 * because money must never move inside a transaction that can roll back.
 */
export async function refundSystemInitiated(
  tx: Tx,
  ctx: Ctx,
  input: SystemRefundInput,
): Promise<SystemRefundResult> {
  const { orderId, reason } = input;
  const reasonText = SYSTEM_REASONS[reason];

  const order = await repo.lockOrder(tx, orderId);
  if (!order || order.deletedAt !== null) throw new DomainError('REFUND_ORDER_NOT_FOUND');
  if (order.paidAmount === null) {
    // Nothing was collected, so there is nothing to give back. The caller
    // should not have reached here — the group-buy sweep only records the
    // effect for members whose order is paid — so this is a bug report, not a
    // quiet no-op.
    throw new DomainError('REFUND_ORDER_NOT_REFUNDABLE', {
      details: { orderId: toId(orderId), reason: 'order-not-paid' },
    });
  }

  // An order a coupon paid for in full still owes the shopper everything but
  // money: the refund is worth 0 and settles without the gateway (REFUND-016).
  const zeroPaid = !Money.parse(order.paidAmount).isPositive();

  const already = (await listAutomaticRefunds(tx, orderId)).find(
    (row) => row.reason === reasonText && row.status !== 'cancelled' && row.status !== 'rejected',
  );
  if (already) return { refundId: already.id, created: false };

  const items = await repo.listOrderItems(tx, orderId);
  const lines: repo.NewRefundItemInput[] = [];
  let amount = Money.ZERO;
  let quantity = 0;
  let everythingCovered = true;

  for (const item of items) {
    const remaining = item.quantity - item.refundedQuantity;
    if (remaining <= 0) continue;
    if (item.shippedQuantity > 0) {
      // Goods that have gone out are not this function's business: what the
      // buyer keeps is settled by a person, through the ordinary after-sales
      // road, with an inspection at the end of it.
      everythingCovered = false;
      continue;
    }
    const lineAmount = zeroPaid
      ? Money.ZERO
      : lineRefundAmount(
          {
            orderItemId: item.id,
            quantity: item.quantity,
            refundedQuantity: item.refundedQuantity,
            shippedQuantity: item.shippedQuantity,
            totalAmount: item.totalAmount,
            refundedAmount: item.refundedAmount,
            isOpen: false,
          },
          remaining,
        );
    amount = amount.add(lineAmount);
    quantity += remaining;
    lines.push({
      refundId: 0,
      orderItemId: item.id,
      quantity: remaining,
      amount: lineAmount.toString(),
    });
  }

  if (lines.length === 0) {
    // Everything is already back, or everything shipped. Answering with the
    // refund that settled it keeps the caller idempotent instead of parking an
    // effect for an order nobody owes anything on.
    const settled = await findSucceededRefund(tx, orderId);
    if (settled) return { refundId: settled.id, created: false };
    throw new DomainError('REFUND_AMOUNT_ZERO', { details: { orderId: toId(orderId) } });
  }

  // Freight follows the same rule as a buyer's full refund: back only while
  // nothing has shipped, and only when this refund covers every remaining unit.
  const freight = Money.parse(order.freightAmount);
  let includesFreight =
    !zeroPaid &&
    everythingCovered &&
    freightRefundable(order.fulfillmentStatus) &&
    freight.isPositive();
  if (includesFreight) amount = amount.add(freight);

  const ceiling = remainingCeiling({
    paidAmount: order.paidAmount,
    refundedAmount: order.refundedAmount,
    openAmount: await repo.openRefundTotal(tx, orderId),
  });
  if (!ceiling.isPositive() && !zeroPaid) {
    const settled = await findSucceededRefund(tx, orderId);
    if (settled) return { refundId: settled.id, created: false };
    throw new DomainError('REFUND_EXCEEDS_PAID', {
      details: { requested: amount.toString(), remaining: ceiling.toString() },
    });
  }
  if (amount.gt(ceiling)) {
    // An operator refunded part of this order by hand before the sweep ran, or
    // a coupon meant the lines always added up to more than was collected.
    // Giving back what is left is right; giving back the full lines would push
    // the order past what it paid, and `orders_refunded_within_paid` would
    // refuse it at settlement time anyway — after the money had gone.
    //
    // The cap is spread over the lines in order and only what survives them
    // pays the freight, so `refunds.amount` and its `refund_items` still add up
    // to the same number. `settleRefundSucceeded` raises each line by its own
    // row, and a line carrying more than the refund as a whole would quietly
    // over-refund the item.
    ctx.logger.warn(
      {
        orderId: toId(orderId),
        reason,
        requested: amount.toString(),
        remaining: ceiling.toString(),
      },
      'system refund capped by the cumulative ceiling',
    );
    let left = ceiling;
    for (const line of lines) {
      const share = Money.parse(line.amount);
      const given = share.lte(left) ? share : left;
      line.amount = given.toString();
      left = left.sub(given);
    }
    includesFreight = includesFreight && left.isPositive();
    amount = ceiling;
  }

  const attempt = await findPaidPaymentAttempt(tx, orderId);
  const now = ctx.clock.now();
  const refund = await repo.insertRefund(tx, {
    refundNo: generateOrderNo(ctx.clock, { prefix: REFUND_NO_PREFIX }),
    outRefundNo: generateOrderNo(ctx.clock, { prefix: OUT_REFUND_NO_PREFIX }),
    orderId,
    userId: order.userId,
    paymentAttemptId: attempt?.id ?? null,
    // Always 仅退款: there is nothing to send back. A system refund that asked
    // the buyer to post goods they never received would be absurd.
    kind: 'refund_only',
    returnStage: 'not_required',
    quantity,
    amount: amount.toString(),
    includesFreight,
    reason: reasonText,
    explanation: null,
    images: [],
    isAutomatic: true,
  });

  try {
    await repo.insertRefundItems(
      tx,
      lines.map((line) => ({ ...line, refundId: refund.id })),
    );
  } catch (error) {
    // Somebody else's request already holds one of these lines — a buyer who
    // applied for a refund on the same order while the team was expiring. Their
    // request stands; the shop does not open a second one on top of it.
    if (repo.isUniqueViolation(error, 'refund_items_open_uq')) {
      throw new DomainError('REFUND_ALREADY_OPEN', { details: { orderId: toId(orderId) } });
    }
    throw error;
  }

  // Straight to `approved`: there is no review step, and `executeRefund` only
  // claims a row that is already past one. `reviewed_by_admin_id` stays null,
  // which is the truthful record — no admin decided this.
  //
  // The same step `adminApprove` takes for a 仅退款: raise `refunded_quantity`
  // now so the warehouse cannot ship goods the shop has just decided to refund.
  // The request is minutes old, so nothing has shipped since it; the order lock
  // held above keeps it that way until commit.
  // Losing means the units went out the door first, and rolling back is right —
  // the effect retries, finds a shipped line, and the order falls to a person.
  const { won, refusedLines } = await repo.transitionRefund(
    tx,
    refund.id,
    ['applied'],
    'approved',
    {
      reviewedAt: now,
      ...(input.note === undefined ? {} : { adminRemark: input.note.slice(0, 255) }),
    },
    'approval',
  );
  if (!won) throw new DomainError('REFUND_NOT_ACTIONABLE', { details: { status: refund.status } });
  const [shipped] = refusedLines;
  if (shipped !== undefined) {
    throw new DomainError('REFUND_LINE_ALREADY_SHIPPED', {
      details: { orderItemId: toId(shipped) },
    });
  }

  await refreshOrderRefundStatus(tx, orderId);
  await repo.insertLog(tx, {
    refundId: refund.id,
    fromStatus: null,
    toStatus: 'approved',
    message: reasonText,
  });

  // Post-commit, like every gateway call in this codebase. One row per refund
  // by `(scope, scope_id, event_type)`, so a retried caller queues one send.
  await recordEffect(tx, ctx, {
    scope: 'refund',
    scopeId: String(refund.id),
    eventType: 'refund.execute',
    payload: { refundId: toId(refund.id) },
  });

  ctx.logger.info(
    { orderId: toId(orderId), refundId: toId(refund.id), amount: amount.toString(), reason },
    'system-initiated refund opened',
  );
  return { refundId: refund.id, created: true };
}
