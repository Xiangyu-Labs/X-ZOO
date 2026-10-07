import type {
  RefundApplyBody,
  RefundDetail,
  RefundItem,
  RefundKind,
  RefundLine,
  RefundListItem,
  RefundReturnShipmentBody,
  RefundableItem,
  RefundableItemsResult,
} from '@shop/contracts/refund/schemas';
import type { Tx } from '@shop/db';
import { release as releaseCoupon, revokeOrderGifts } from '../coupon';
import { recordEffect } from '../effects';
import { requireUserId, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { generateOrderNo, toId, toIdOrNull } from '../kernel/ids';
import { Money } from '../kernel/money';
import { notify } from '../notification';
import { requireOrderRef, resolveStockPort } from '../order';
import { onOrderRefunded } from '../order/ports';
import { isStoredImageUrl } from '../storage';
import {
  applyExceptionRefundNotification,
  findPaidPaymentAttempt,
  markCallbackProcessed,
  payClient,
  recordCallback,
  recordCapitalFlow,
  type WebhookResult,
} from '../payment';
import { REFUND_NO_ANSWER, refundEndedMessage, refundRefusalMessage } from '../wechat';
import { REFUND_EXCEPTION_EVENT } from './refund.notifications';
import * as repo from './refund.repo';
import {
  buyerMayWithdraw,
  coversEverything,
  freightRefundable,
  lineRefundAmount,
  openedByShop,
  orderRefundStatus,
  refundableLine,
  remainingCeiling,
  shopperLogMessage,
} from './refund.rules';

/**
 * After-sales: the request, the review, and the money going back.
 *
 * ## Three invariants, three mechanisms
 *
 * 1. **One in-flight refund per order line.** Enforced by the partial unique
 *    index `refund_items(order_item_id) WHERE is_open` — two simultaneous
 *    applications for one line end with one insert and one unique violation,
 *    which becomes `REFUND_ALREADY_OPEN`. There is no read-then-write window to
 *    lose, and it does not matter that the two requests arrived at different
 *    processes.
 * 2. **Never give back more than was collected.** Checked under `FOR UPDATE` on
 *    the order row, re-checked inside the settling `UPDATE`'s own `WHERE`, and
 *    backstopped by `orders_refunded_within_paid` (REFUND-007).
 * 3. **The merchant refund number and the amount are frozen at creation.** A
 *    retry re-sends the same number, so WeChat itself deduplicates it; an
 *    unknown answer is *queried* by that number and never re-sent under a new
 *    one (REFUND-005 / REFUND-006).
 *
 * ## Where the gateway call sits
 *
 * Never inside a transaction. `executeRefund` claims the row (`approved →
 * processing`), leaves the transaction, calls WeChat, and records the answer in
 * a second transaction. A crash in between leaves `processing`, which is exactly
 * what the reconciliation sweep looks for.
 *
 * ## What "unknown" means here
 *
 * An unverifiable gateway answer restores nothing — not the order's refunded
 * total, not a line's refunded quantity, not the coupon. The row goes to
 * `unknown` and a human or the sweep resolves it by querying the frozen number.
 * Refunding money twice is recoverable; telling the rest of the system that
 * money came back when it did not is not.
 */

const REFUND_NO_PREFIX = 'RF';
const OUT_REFUND_NO_PREFIX = 'R';

/** The canned reasons the apply screen offers. */
export const REFUND_REASONS = [
  '不想要了',
  '商品破损',
  '与描述不符',
  '发错货',
  '少件/漏发',
  '质量问题',
  '快递一直未送达',
  '其他',
] as const;

export function refundReasons(): { items: string[] } {
  return { items: [...REFUND_REASONS] };
}

// ---------------------------------------------------------------------------
// the apply screen
// ---------------------------------------------------------------------------

export async function applicableItems(
  ctx: Ctx,
  input: { orderId: string },
): Promise<RefundableItemsResult> {
  const { orderId, userId } = await requireOrderRef(ctx, input.orderId, 'REFUND_ORDER_NOT_FOUND');
  const order = await repo.findOrder(ctx.db, orderId);
  if (!order || order.deletedAt !== null || order.userId !== userId) {
    throw new DomainError('REFUND_ORDER_NOT_FOUND');
  }
  if (order.paidAmount === null || order.status === 'cancelled') {
    throw new DomainError('REFUND_ORDER_NOT_REFUNDABLE');
  }
  return refundableFor(ctx, order, order.paidAmount);
}

/**
 * The apply screen's answer for an order already found and checked: the
 * buyer's (`applicableItems`) and the operator's (`adminApplicable`).
 */
export async function refundableFor(
  ctx: Ctx,
  order: repo.OrderRefundRow,
  paidAmount: string,
): Promise<RefundableItemsResult> {
  const orderId = order.id;
  const [items, openIds, openTotal, freightTaken] = await Promise.all([
    repo.listOrderItems(ctx.db, orderId),
    repo.listOpenItemIds(ctx.db, orderId),
    repo.openRefundTotal(ctx.db, orderId),
    repo.freightClaimed(ctx.db, orderId),
  ]);
  const open = new Set(openIds);

  const lines: RefundableItem[] = items.map((item) => {
    const line = refundableLine({
      orderItemId: item.id,
      quantity: item.quantity,
      refundedQuantity: item.refundedQuantity,
      shippedQuantity: item.shippedQuantity,
      totalAmount: item.totalAmount,
      refundedAmount: item.refundedAmount,
      isOpen: open.has(item.id),
    });
    return {
      orderItemId: toId(item.id),
      itemKey: item.itemKey,
      productName: item.snapshot.productName,
      productImageUrl: item.snapshot.productImageUrl,
      specText: item.snapshot.specText,
      quantity: item.quantity,
      refundedQuantity: item.refundedQuantity,
      shippedQuantity: item.shippedQuantity,
      refundableQuantity: line.refundableQuantity,
      unitPrice: item.unitPrice,
      totalAmount: item.totalAmount,
      refundableAmount: line.refundableAmount.toString(),
      blockedReason: line.blockedReason,
    };
  });

  const ceiling = remainingCeiling({
    paidAmount,
    refundedAmount: order.refundedAmount,
    openAmount: openTotal,
  });

  return {
    orderId: toId(order.id),
    orderNo: order.orderNo,
    paidAmount,
    refundedAmount: order.refundedAmount,
    refundableAmount: ceiling.toString(),
    freightAmount: order.freightAmount,
    // The same three conditions `apply` checks, so the apply screen's
    // `includesFreight` and the server agree (REFUND-018).
    freightRefundable:
      freightRefundable(order.fulfillmentStatus) &&
      Money.parse(paidAmount).isPositive() &&
      !freightTaken,
    items: lines,
  };
}

// ---------------------------------------------------------------------------
// applying
// ---------------------------------------------------------------------------

/**
 * 申请售后.
 *
 * Every evidence photo must be an image our own storage holds — what
 * `POST /api/v1/uploads` returned (REFUND-014), the rule a review picture
 * (CAT-018) and the avatar (USER-019) already follow. Only the shopper and the
 * merchant see them, but a link to somebody else's server would hand that
 * server the IP and browser of every admin who opens the request. Checked
 * before the order is locked, so a refused photo costs no transaction.
 */
export async function apply(ctx: Ctx, body: RefundApplyBody): Promise<RefundDetail> {
  const userId = requireUserId(ctx);
  const orderId = Number(body.orderId);
  for (const url of new Set(body.images)) {
    if (!(await isStoredImageUrl(ctx, url))) throw new DomainError('REFUND_IMAGE_NOT_ALLOWED');
  }

  const refundId = await ctx.withTx(async (tx) => {
    const order = await repo.lockOrder(tx, orderId);
    if (!order || order.deletedAt !== null || order.userId !== userId) {
      throw new DomainError('REFUND_ORDER_NOT_FOUND');
    }
    const paidAmount = refundableOrderPaid(order);
    const priced = await priceRequest(tx, order, paidAmount, body);
    const refund = await openRefund(tx, ctx, {
      order,
      priced,
      kind: body.kind,
      reason: body.reason,
      explanation: body.explanation ?? null,
      images: body.images,
      initiatedByAdminId: null,
    });

    await repo.insertLog(tx, {
      refundId: refund.id,
      fromStatus: null,
      toStatus: 'applied',
      message: `买家发起${body.kind === 'return_and_refund' ? '退货退款' : '仅退款'}申请`,
      operatorUserId: userId,
    });

    // The receipt and the 待处理 badge, both inside this transaction — a
    // request that lost the `refund_items_open_uq` race above must leave
    // neither behind. The subject is the **refund**, not the order: two partial
    // refunds of one order are two notifications, which is exactly what a
    // per-order key would have swallowed.
    const applied = {
      refundId: refund.id,
      refundNo: refund.refundNo,
      orderNo: order.orderNo,
      amount: priced.amount.toString(),
    };
    await notify(tx, ctx, {
      event: 'refund_applied',
      subject: { scope: 'refund', id: refund.id },
      userId,
      data: applied,
    });
    await notify(tx, ctx, {
      event: 'admin_refund_applied',
      subject: { scope: 'refund', id: refund.id },
      data: { ...applied, reason: body.reason },
    });

    return refund.id;
  });

  return detail(ctx, refundId);
}

/**
 * The money an order collected, if after-sales may still be opened on it: paid,
 * and neither cancelled nor already refunded in full. The same rule for the
 * buyer's request and the operator's.
 */
export function refundableOrderPaid(order: repo.OrderRefundRow): string {
  if (order.paidAmount === null || order.status === 'cancelled' || order.status === 'refunded') {
    throw new DomainError('REFUND_ORDER_NOT_REFUNDABLE');
  }
  return order.paidAmount;
}

export interface PricedRequest {
  lines: repo.NewRefundItemInput[];
  amount: Money;
  quantity: number;
  freight: string | null;
}

/**
 * What a request for these lines is worth, under the order lock.
 *
 * The request names lines and quantities, never money: each line gives back its
 * allocated share (`lineRefundAmount`), freight only by `refundableFreight`'s
 * rule, and the whole must fit under what other open requests have left
 * (REFUND-005, REFUND-007). The buyer's `apply` and the operator's
 * `adminCreate` both price through here, so the two can never disagree.
 */
export async function priceRequest(
  tx: Tx,
  order: repo.OrderRefundRow,
  paidAmount: string,
  wanted: { lines: readonly RefundLine[]; includeFreight: boolean },
): Promise<PricedRequest> {
  const orderId = order.id;
  const items = new Map(
    (await repo.listOrderItems(tx, orderId)).map((item) => [item.id, item] as const),
  );
  // A coupon paid for all of it: every line is worth nothing, and the request
  // gives back units, the coupon and the seat rather than money (REFUND-016).
  const zeroPaid = !Money.parse(paidAmount).isPositive();
  // Two entries for one line are one claim on that line; summing first is what
  // stops `[{id: 7001, qty: 1}, {id: 7001, qty: 1}]` refunding two units of a
  // one-unit line through two separate remaining-quantity checks.
  const asked = new Map<number, number>();
  for (const line of wanted.lines) {
    const key = Number(line.orderItemId);
    asked.set(key, (asked.get(key) ?? 0) + line.quantity);
  }

  let amount = Money.ZERO;
  let quantity = 0;
  const lines: repo.NewRefundItemInput[] = [];

  for (const [orderItemId, units] of asked) {
    const item = items.get(orderItemId);
    if (!item || item.orderId !== orderId) throw new DomainError('REFUND_LINE_INVALID');
    const remaining = item.quantity - item.refundedQuantity;
    if (units > remaining) {
      throw new DomainError('REFUND_LINE_INVALID', {
        details: { orderItemId: toId(orderItemId), remaining },
      });
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
          units,
        );
    amount = amount.add(lineAmount);
    quantity += units;
    lines.push({
      refundId: 0,
      orderItemId: item.id,
      quantity: units,
      amount: lineAmount.toString(),
    });
  }

  const freight =
    wanted.includeFreight && !zeroPaid
      ? refundableFreight(order, items, asked, {
          held: new Set(await repo.listOpenItemIds(tx, orderId)),
          claimed: await repo.freightClaimed(tx, orderId),
        })
      : null;
  if (freight !== null) amount = amount.add(Money.parse(freight));

  if (!amount.isPositive() && !zeroPaid) throw new DomainError('REFUND_AMOUNT_ZERO');

  // The ceiling counts what other open requests have already spoken for, so
  // two requests on two different lines cannot together exceed what was paid.
  const ceiling = remainingCeiling({
    paidAmount,
    refundedAmount: order.refundedAmount,
    openAmount: await repo.openRefundTotal(tx, orderId),
  });
  if (amount.gt(ceiling)) {
    throw new DomainError('REFUND_EXCEEDS_PAID', {
      details: { requested: amount.toString(), remaining: ceiling.toString() },
    });
  }

  return { lines, amount, quantity, freight };
}

/**
 * Inserts a priced request as `applied`, with its lines, and rolls the order's
 * refund status up. The caller holds the order lock and writes the log.
 */
export async function openRefund(
  tx: Tx,
  ctx: Ctx,
  input: {
    order: repo.OrderRefundRow;
    priced: PricedRequest;
    kind: RefundKind;
    reason: string;
    explanation: string | null;
    images: string[];
    initiatedByAdminId: number | null;
  },
): Promise<repo.RefundRow> {
  const { order, priced } = input;
  const attempt = await findPaidPaymentAttempt(tx, order.id);
  const refund = await repo.insertRefund(tx, {
    refundNo: generateOrderNo(ctx.clock, { prefix: REFUND_NO_PREFIX }),
    outRefundNo: generateOrderNo(ctx.clock, { prefix: OUT_REFUND_NO_PREFIX }),
    orderId: order.id,
    userId: order.userId,
    paymentAttemptId: attempt?.id ?? null,
    kind: input.kind,
    returnStage: input.kind === 'return_and_refund' ? 'awaiting_shipment' : 'not_required',
    quantity: priced.quantity,
    amount: priced.amount.toString(),
    includesFreight: priced.freight !== null,
    reason: input.reason,
    explanation: input.explanation,
    images: input.images,
    isAutomatic: false,
    initiatedByAdminId: input.initiatedByAdminId,
  });

  try {
    await repo.insertRefundItems(
      tx,
      priced.lines.map((line) => ({ ...line, refundId: refund.id })),
    );
  } catch (error) {
    // `refund_items_open_uq`: somebody else's request already holds one of
    // these lines. The database decided the race; we only name it.
    if (repo.isUniqueViolation(error, 'refund_items_open_uq')) {
      throw new DomainError('REFUND_ALREADY_OPEN');
    }
    throw error;
  }

  await refreshOrderRefundStatus(tx, order.id);
  return refund;
}

/**
 * Whether freight goes into this request, and how much.
 *
 * Three conditions: nothing has shipped, no other request has taken the
 * freight already, and the request covers every remaining unrefunded unit of
 * the order that nobody else holds — a line inside another in-flight request
 * counts as taken, as it does on the apply screen (REFUND-018). A partial
 * refund never carries freight, because the shop still has to post the parcel
 * the rest of the order is in.
 */
function refundableFreight(
  order: repo.OrderRefundRow,
  items: ReadonlyMap<number, repo.OrderItemRow>,
  asked: ReadonlyMap<number, number>,
  others: { held: ReadonlySet<number>; claimed: boolean },
): string | null {
  if (!freightRefundable(order.fulfillmentStatus)) {
    throw new DomainError('REFUND_FREIGHT_NOT_REFUNDABLE');
  }
  if (others.claimed) {
    throw new DomainError('REFUND_FREIGHT_NOT_REFUNDABLE', {
      details: { reason: 'already-claimed' },
    });
  }
  const everything = coversEverything(
    [...items.values()].map((item) => ({
      remaining: item.quantity - item.refundedQuantity,
      asked: asked.get(item.id) ?? 0,
      held: others.held.has(item.id),
    })),
  );
  if (!everything) {
    throw new DomainError('REFUND_FREIGHT_NOT_REFUNDABLE', {
      details: { reason: 'partial-refund' },
    });
  }
  const freight = Money.parse(order.freightAmount);
  return freight.isPositive() ? freight.toString() : null;
}

// ---------------------------------------------------------------------------
// the shopper's own actions
// ---------------------------------------------------------------------------

/**
 * The buyer withdraws.
 *
 * Only from `applied`, `approved` or `failed` (`buyerMayWithdraw`), and the
 * conditional update is the whole guard: an operator approving-and-executing
 * — or retrying a failed one — at the same moment either gets there first (and
 * this answers `REFUND_NOT_ACTIONABLE`) or arrives to find the row already
 * `cancelled` and refuses to execute. Money never leaves on a withdrawn
 * request, and a withdrawal never lands on money already gone.
 *
 * A refund the shop opened by itself is not the buyer's to withdraw: its order
 * cannot ship (the group buy failed), so withdrawing it would strand the money.
 * The units an approved 仅退款 took come back to fulfilment in the same step
 * (`transitionRefund`, REFUND-015).
 */
export async function cancel(ctx: Ctx, input: { id: string }): Promise<RefundDetail> {
  const userId = requireUserId(ctx);
  const id = Number(input.id);

  await ctx.withTx(async (tx) => {
    const row = await repo.lockRefund(tx, id);
    if (!row || row.userId !== userId) throw new DomainError('REFUND_NOT_FOUND');
    if (!buyerMayWithdraw(row)) {
      throw new DomainError('REFUND_NOT_ACTIONABLE', { details: { status: row.status } });
    }
    const { won } = await repo.transitionRefund(
      tx,
      id,
      ['applied', 'approved', 'failed'],
      'cancelled',
      { cancelledAt: ctx.clock.now() },
    );
    if (!won) throw new DomainError('REFUND_NOT_ACTIONABLE', { details: { status: row.status } });

    await repo.insertLog(tx, {
      refundId: id,
      fromStatus: row.status,
      toStatus: 'cancelled',
      message: '买家撤销申请',
      operatorUserId: userId,
    });
    await refreshOrderRefundStatus(tx, row.orderId);
  });

  return detail(ctx, id);
}

export async function submitReturnShipment(
  ctx: Ctx,
  input: { id: string } & RefundReturnShipmentBody,
): Promise<RefundDetail> {
  const userId = requireUserId(ctx);
  const id = Number(input.id);

  await ctx.withTx(async (tx) => {
    const row = await repo.lockRefund(tx, id);
    if (!row || row.userId !== userId) throw new DomainError('REFUND_NOT_FOUND');
    if (row.kind !== 'return_and_refund') throw new DomainError('REFUND_RETURN_NOT_EXPECTED');

    const { won } = await repo.setReturnShipment(tx, id, {
      returnExpressCompanyId: Number(input.expressCompanyId),
      returnTrackingNo: input.trackingNo,
      returnPhone: input.phone ?? null,
    });
    if (!won) {
      // Not approved yet, or the goods have already been received: either way
      // the shopper is looking at a screen the server has moved past.
      throw new DomainError('REFUND_RETURN_NOT_EXPECTED', {
        details: { status: row.status, returnStage: row.returnStage },
      });
    }
    await repo.insertLog(tx, {
      refundId: id,
      fromStatus: row.status,
      toStatus: row.status,
      message: `买家填写退货物流 ${input.trackingNo}`,
      operatorUserId: userId,
    });
  });

  return detail(ctx, id);
}

/** Hides a finished request from the buyer's own list. Never deletes anything. */
export async function hide(ctx: Ctx, input: { id: string }): Promise<{ deleted: boolean }> {
  const userId = requireUserId(ctx);
  const id = Number(input.id);
  const row = await repo.findRefund(ctx.db, id);
  if (!row || row.userId !== userId) throw new DomainError('REFUND_NOT_FOUND');
  const { won } = await repo.hideRefund(ctx.db, id, userId, ctx.clock.now());
  if (!won) throw new DomainError('REFUND_NOT_ACTIONABLE', { details: { status: row.status } });
  return { deleted: true };
}

export async function myList(
  ctx: Ctx,
  query: { state: 'all' | 'open' | 'succeeded' | 'closed'; page: number; pageSize: number },
): Promise<{ items: RefundListItem[]; total: number; page: number; pageSize: number }> {
  const userId = requireUserId(ctx);
  const { rows, total } = await repo.listMyRefunds(ctx.db, {
    userId,
    state: query.state,
    offset: (query.page - 1) * query.pageSize,
    limit: query.pageSize,
  });
  const items = await repo.listItemsForRefunds(
    ctx.db,
    rows.map((r) => r.id),
  );
  return {
    items: rows.map((row) => toListItem(row, items.get(row.id) ?? [])),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function myDetail(ctx: Ctx, input: { id: string }): Promise<RefundDetail> {
  const userId = requireUserId(ctx);
  const row = await repo.findRefund(ctx.db, Number(input.id));
  if (!row || row.userId !== userId) throw new DomainError('REFUND_NOT_FOUND');
  return detail(ctx, row.id);
}

// ---------------------------------------------------------------------------
// execution: the gateway call
// ---------------------------------------------------------------------------

export interface ExecuteResult {
  status: 'succeeded' | 'processing' | 'failed' | 'unknown';
  message: string;
}

/**
 * Sends one approved refund to WeChat.
 *
 * Idempotent three times over: the claim only moves a row *out* of a state that
 * allows execution, `out_refund_no` is frozen so WeChat deduplicates a re-send,
 * and the settlement is a conditional update that a racing refund notification
 * simply wins instead.
 */
export async function executeRefund(ctx: Ctx, refundId: number): Promise<ExecuteResult> {
  const claim = await ctx.withTx(async (tx) => {
    const row = await repo.lockRefund(tx, refundId);
    if (!row) throw new DomainError('REFUND_NOT_FOUND');
    if (row.status === 'succeeded') return null;
    // A return pays out only once the goods are back (`adminReceiveReturn`).
    // 同意 on a return asks for the parcel; 复核 on that row must not send money.
    if (row.kind === 'return_and_refund' && row.returnStage !== 'received') {
      throw new DomainError('REFUND_NOT_ACTIONABLE', {
        details: { status: row.status, returnStage: row.returnStage },
      });
    }
    // Nothing to send: an order a coupon paid for in full. WeChat cannot
    // refund 0 and there is no payment to refund through, so the request
    // settles here and gives back what it can — units, the coupon, the seat
    // (REFUND-016).
    if (Money.parse(row.amount).isZero()) {
      const { won, refusedLines } = await repo.transitionRefund(
        tx,
        refundId,
        ['approved', 'processing', 'unknown', 'failed'],
        'processing',
        NO_PROBLEM,
        'retry',
      );
      if (!won) throw new DomainError('REFUND_NOT_ACTIONABLE', { details: { status: row.status } });
      refuseShippedLines(refusedLines);
      await settleRefundSucceeded(tx, ctx, refundId, { gatewayRefundId: null, source: 'zero' });
      return null;
    }

    // Frozen on the first submit and never rewritten, so a later config change
    // or a second payment attempt cannot redirect a refund already in flight.
    const context = row.requestContext ?? (await freezeContext(tx, row));
    if (context === null) throw new DomainError('REFUND_NO_ORIGINAL_PAYMENT');
    if (!Money.parse(context.refundAmount).eq(Money.parse(row.amount))) {
      // A retry that disagrees with what was frozen is refused, not corrected:
      // the frozen amount is the one WeChat may already have seen (REFUND-005).
      throw new DomainError('REFUND_AMOUNT_MISMATCH', {
        details: { frozenAmount: context.refundAmount, requestedAmount: row.amount },
      });
    }

    const { won, refusedLines } = await repo.transitionRefund(
      tx,
      refundId,
      ['approved', 'processing', 'unknown', 'failed'],
      'processing',
      { requestContext: context, ...NO_PROBLEM },
      'retry',
    );
    if (!won) throw new DomainError('REFUND_NOT_ACTIONABLE', { details: { status: row.status } });
    refuseShippedLines(refusedLines);
    return { ...row, requestContext: context };
  });

  if (claim === null) return { status: 'succeeded', message: '已退款' };
  const context = claim.requestContext;
  if (context === null) throw new DomainError('REFUND_NO_ORIGINAL_PAYMENT');

  const client = await payClient(ctx);
  if (!client.configured) throw new DomainError('PAYMENT_NOT_CONFIGURED');

  try {
    const gateway = await client.createRefund({
      outRefundNo: claim.outRefundNo,
      outTradeNo: context.outTradeNo,
      transactionId: context.transactionId,
      refundAmount: Money.parse(claim.amount),
      totalAmount: Money.parse(context.totalAmount),
      reason: claim.reason ?? '售后退款',
    });

    if (gateway.status === 'SUCCESS') {
      await ctx.withTx((tx) =>
        settleRefundSucceeded(tx, ctx, refundId, {
          gatewayRefundId: gateway.refundId,
          source: 'refund api',
        }),
      );
      return { status: 'succeeded', message: '退款成功' };
    }

    if (gateway.status === 'PROCESSING') {
      // WeChat will tell us in a callback; the sweep asks if it never does.
      await ctx.withTx((tx) =>
        repo.transitionRefund(tx, refundId, ['processing'], 'processing', {
          gatewayRefundId: gateway.refundId,
        }),
      );
      return { status: 'processing', message: '退款处理中' };
    }

    const ended = gatewayStatusProblem(gateway.status);
    await ctx.withTx((tx) => failRefund(tx, ctx, refundId, ended));
    return { status: 'failed', message: ended.summary };
  } catch (error) {
    // A refusal is an answer: the gateway did not take the money, so the request
    // becomes retryable. Anything else is silence, and silence restores nothing.
    const refused =
      error instanceof DomainError && error.code === 'PAYMENT_GATEWAY_REFUSED' ? error : null;
    await ctx.withTx(async (tx) => {
      if (refused) {
        await failRefund(tx, ctx, refundId, refusalProblem(refused));
        return;
      }
      const { won } = await repo.transitionRefund(tx, refundId, ['processing'], 'unknown', {
        lastError: messageOf(error),
        lastErrorSummary: NO_ANSWER,
      });
      if (won) {
        // The gateway's words go to `last_error`, which staff read only under
        // 技术详情; the log is the shopper's timeline too (REFUND-019).
        await repo.insertLog(tx, {
          refundId,
          fromStatus: 'processing',
          toStatus: 'unknown',
          message: '退款结果待确认',
        });
      }
    });
    ctx.logger.error({ err: error, refundId, refused: refused !== null }, 'refund submit failed');
    return refused
      ? { status: 'failed', message: refundRefusalMessage(refused) }
      : { status: 'unknown', message: NO_ANSWER };
  }
}

/**
 * A retry that would have to take units the warehouse has shipped since the
 * request failed is refused rather than paid: paying it would hand over the
 * goods and the money (REFUND-015). The request is now a return, or a
 * merchant's decision to close.
 */
function refuseShippedLines(refusedLines: readonly number[]): void {
  const [first] = refusedLines;
  if (first === undefined) return;
  throw new DomainError('REFUND_LINE_ALREADY_SHIPPED', {
    details: { orderItemId: toId(first) },
  });
}

/** The payment facts this refund is sent with, read from the paid attempt. */
async function freezeContext(
  tx: Tx,
  row: repo.RefundRow,
): Promise<repo.RefundRequestContext | null> {
  const attempt = await findPaidPaymentAttempt(tx, row.orderId);
  if (!attempt || attempt.transactionId === null) return null;
  return {
    outTradeNo: attempt.outTradeNo,
    transactionId: attempt.transactionId,
    provider: attempt.provider,
    mchId: attempt.mchId,
    appId: attempt.appId,
    channel: attempt.channel,
    totalAmount: attempt.amount,
    refundAmount: row.amount,
    currency: attempt.currency,
  };
}

/**
 * The money is back.
 *
 * This is the only function that raises an order's refunded total, and it does
 * everything in one transaction: the refund reaches `succeeded`, its lines stop
 * being open, the order and its lines take the amount, the ledger gets its row,
 * the roll-up is recomputed, a full refund releases the coupon, takes back the
 * unused gift coupons the order earned (REFUND-020) and ends the order, and
 * `onOrderRefunded` fires for stock.
 *
 * Every step is conditional or idempotent, because a refund notification and a
 * query result can arrive at the same instant and both land here. Returns
 * whether *this* call was the one that settled it.
 */
export async function settleRefundSucceeded(
  tx: Tx,
  ctx: Ctx,
  refundId: number,
  facts: { gatewayRefundId: string | null; source: string },
): Promise<boolean> {
  const row = await repo.lockRefund(tx, refundId);
  if (!row) throw new DomainError('REFUND_NOT_FOUND');
  if (row.status === 'succeeded') return false;

  const now = ctx.clock.now();
  const order = await repo.lockOrder(tx, row.orderId);
  if (!order) throw new DomainError('REFUND_ORDER_NOT_FOUND');

  // The whole line is the ceiling for the units: a `refund_only` already took
  // its units at approval and this re-derivation changes nothing, and a return
  // is by definition made of units that were shipped.
  const { won, refusedLines } = await repo.transitionRefund(
    tx,
    refundId,
    ['approved', 'processing', 'unknown'],
    'succeeded',
    {
      succeededAt: now,
      refundedAmount: row.amount,
      gatewayRefundId: facts.gatewayRefundId,
      ...NO_PROBLEM,
    },
  );
  if (!won) return false;
  for (const orderItemId of refusedLines) {
    // The database CHECK would refuse anything truly impossible; this is the
    // readable version, and it must not be silent — the money is already
    // back, so somebody has to look at the line.
    ctx.logger.error(
      { refundId: toId(refundId), orderItemId: toId(orderItemId) },
      'refunded quantity could not be re-derived for a settled refund line',
    );
  }

  const amount = Money.parse(row.amount);
  const raised = await repo.addOrderRefundedAmount(tx, row.orderId, row.amount);
  if (!raised.won) {
    // `orders_refunded_within_paid` would have refused this anyway; refusing
    // here keeps the error readable and rolls the whole settlement back rather
    // than half of it.
    throw new DomainError('REFUND_EXCEEDS_PAID', {
      details: { refundId: toId(refundId), amount: row.amount },
    });
  }

  const lines = await repo.listRefundItems(tx, refundId);
  for (const item of lines) {
    await repo.addItemRefundedAmount(tx, item.orderItemId, item.amount);
  }
  await restock(tx, ctx, { orderId: row.orderId, refundId, lines });

  // A zero refund moved no money, so the ledger has nothing to record (and
  // `capital_flows_amount_positive` would refuse the row).
  if (amount.isPositive()) {
    await recordCapitalFlow(tx, {
      kind: 'order_refund',
      reference: row.outRefundNo,
      direction: 'out',
      amount: row.amount,
      orderId: row.orderId,
      userId: row.userId,
      mchId: row.requestContext?.mchId ?? null,
      transactionId: facts.gatewayRefundId ?? row.requestContext?.transactionId ?? null,
      note: `售后退款 ${row.refundNo}`,
      occurredAt: now,
    });
  }

  const rollup = await currentRollup(tx, row.orderId, {
    paidAmount: order.paidAmount,
    refundedAmount: Money.parse(order.refundedAmount).add(amount),
  });
  await repo.setOrderRefundStatus(tx, row.orderId, rollup);

  const full = rollup === 'refunded';
  if (full) {
    await repo.markOrderRefunded(tx, row.orderId);
    // A fully refunded order gives its coupon back; a partial one does not,
    // because the order it was spent on still stands.
    if (order.userCouponId !== null) {
      await releaseCoupon(tx, ctx, { userCouponId: order.userCouponId, orderId: row.orderId });
    }
    // …and takes back the gift coupons it earned and nobody has spent yet
    // (REFUND-020). A spent one stays spent: its own order stands.
    await revokeOrderGifts(tx, ctx, { orderId: row.orderId });
  }

  ctx.logger.info({ refundId: toId(refundId), source: facts.source }, 'refund settled');
  await repo.insertLog(tx, {
    refundId,
    fromStatus: row.status,
    toStatus: 'succeeded',
    message: amount.isPositive() ? '退款成功，款项已原路退回' : '售后已完成',
  });

  await onOrderRefunded.dispatch(tx, ctx, {
    orderId: row.orderId,
    orderNo: order.orderNo,
    userId: row.userId,
    at: now,
    refundId,
    refundNo: row.refundNo,
    refundedAmount: amount,
    partial: !full,
  });

  // Post-commit work other domains own: the buyer's notification and anything
  // the order domain hangs off a finished order. Recorded in this transaction
  // so it cannot happen for a refund that rolled back.
  await recordEffect(tx, ctx, {
    scope: 'order',
    scopeId: String(row.orderId),
    eventType: 'order.refunded',
    payload: {
      refundId: toId(refundId),
      refundNo: row.refundNo,
      orderId: toId(row.orderId),
      userId: toId(row.userId),
      amount: row.amount,
      full,
      refundedAt: now.toISOString(),
    },
  });

  return true;
}

/**
 * Puts the refunded units back on the shelf — but only the ones that never left
 * the warehouse.
 *
 * The rule is per line: a line whose `shipped_quantity` is still zero goes
 * back, and a line that has gone out does not. A 退货退款 of dispatched goods
 * reaches the shelf through the operator's own inbound step, which is where the
 * inspection that decides whether it is *sellable* belongs — the alternative is
 * a returned broken item silently becoming available stock.
 *
 * `committed: true` because a refund only exists for a paid order, so `commit`
 * has already moved `sales`; `refundId` because an order is refunded line by
 * line and a per-order key would swallow the second partial refund.
 */
async function restock(
  tx: Tx,
  ctx: Ctx,
  input: { orderId: number; refundId: number; lines: readonly repo.RefundItemRow[] },
): Promise<void> {
  const items = new Map(
    (await repo.listOrderItems(tx, input.orderId)).map((item) => [item.id, item] as const),
  );
  const stockLines = input.lines.flatMap((line) => {
    const item = items.get(line.orderItemId);
    if (!item || item.shippedQuantity > 0) return [];
    return [{ skuId: item.skuId, quantity: line.quantity }];
  });
  if (stockLines.length === 0) return;

  await resolveStockPort().release(tx, input.orderId, stockLines, {
    committed: true,
    refundId: input.refundId,
  });
  ctx.logger.info(
    { orderId: input.orderId, refundId: input.refundId, lines: stockLines.length },
    'refund restocked the unshipped lines',
  );
}

async function failRefund(
  tx: Tx,
  ctx: Ctx,
  refundId: number,
  problem: RefundProblem,
): Promise<void> {
  const row = await repo.lockRefund(tx, refundId);
  if (!row) return;
  const { won } = await repo.transitionRefund(
    tx,
    refundId,
    ['approved', 'processing', 'unknown'],
    'failed',
    {
      failedAt: ctx.clock.now(),
      lastError: problem.raw.slice(0, 500),
      lastErrorSummary: problem.summary.slice(0, 500),
    },
  );
  if (!won) return;
  // The reason is on `last_error` for staff; the shopper's timeline says the
  // merchant is on it (REFUND-019).
  await repo.insertLog(tx, {
    refundId,
    fromStatus: row.status,
    toStatus: 'failed',
    message: '退款未完成，商家处理中',
  });
  // A failed request stays in flight: it keeps its lines and a 仅退款 keeps
  // its units out of fulfilment, because the merchant can retry it under the
  // same number (REFUND-017). They come back when it is withdrawn or closed.
  await refreshOrderRefundStatus(tx, row.orderId);
}

/** Recomputes `orders.refund_status` from what is settled and what is still open. */
export async function refreshOrderRefundStatus(tx: Tx, orderId: number): Promise<void> {
  const order = await repo.findOrder(tx, orderId);
  if (!order) return;
  await repo.setOrderRefundStatus(
    tx,
    orderId,
    await currentRollup(tx, orderId, {
      paidAmount: order.paidAmount,
      refundedAmount: Money.parse(order.refundedAmount),
    }),
  );
}

/**
 * The roll-up from the order's money, what is still in flight, and — for an
 * order that collected nothing — its settled units (REFUND-016).
 */
async function currentRollup(
  tx: Tx,
  orderId: number,
  money: { paidAmount: string | null; refundedAmount: Money },
): Promise<ReturnType<typeof orderRefundStatus>> {
  const paid = money.paidAmount === null ? Money.ZERO : Money.parse(money.paidAmount);
  const stillOpen = (await repo.listOpenItemIds(tx, orderId)).length > 0;
  const units =
    money.paidAmount !== null && !paid.isPositive()
      ? await repo.orderUnits(tx, orderId)
      : undefined;
  return orderRefundStatus(money.refundedAmount, paid, stillOpen, units);
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 400);
}

// ---------------------------------------------------------------------------
// what staff read about a failure
// ---------------------------------------------------------------------------

/**
 * A refund's failure as `last_error` and `last_error_summary` hold it: the raw
 * words (the gateway's code and text, a status, a transport error) for 技术详情,
 * and the Chinese line staff read (AGENTS.md rule 1). Written and cleared
 * together.
 */
interface RefundProblem {
  raw: string;
  summary: string;
}

const NO_PROBLEM = { lastError: null, lastErrorSummary: null } as const;

/** The gateway's answer was lost; the reconciliation sweep asks again. */
const NO_ANSWER = `${REFUND_NO_ANSWER}，系统会自动查询；也可以点「重试」立即查询`;

/** What staff can do about an ended refund that is theirs to redo; the wording is `refundEndedMessage`'s. */
const ENDED_RETRY: Record<string, string> = { CLOSED: '，可以点「重试」重新发起' };

function gatewayStatusProblem(
  status: string,
  source: 'gateway' | 'notify' = 'gateway',
): RefundProblem {
  return {
    raw: source === 'notify' ? `notify: ${status}` : `gateway status ${status}`,
    summary: `${refundEndedMessage(status)}${ENDED_RETRY[status] ?? ''}`,
  };
}

function refusalProblem(error: DomainError): RefundProblem {
  const { code, message } = (error.details ?? {}) as { code?: string; message?: string };
  return {
    raw: `refused ${code ?? 'UNKNOWN'}: ${message ?? ''}`.trim(),
    summary: refundRefusalMessage(error),
  };
}

// ---------------------------------------------------------------------------
// reconciliation
// ---------------------------------------------------------------------------

/**
 * Asks the gateway what became of a refund whose answer was lost, by the frozen
 * merchant refund number. Never re-sends (REFUND-006).
 */
export async function reconcileRefund(ctx: Ctx, refundId: number): Promise<ExecuteResult> {
  const row = await repo.findRefund(ctx.db, refundId);
  if (!row) throw new DomainError('REFUND_NOT_FOUND');
  if (row.status === 'succeeded') return { status: 'succeeded', message: '已退款' };
  // The gateway never saw a zero refund, so asking it would read as "no such
  // refund" and fail a request that only has to settle (REFUND-016).
  if (Money.parse(row.amount).isZero()) return executeRefund(ctx, refundId);

  const client = await payClient(ctx);
  if (!client.configured) throw new DomainError('PAYMENT_NOT_CONFIGURED');

  const gateway = await client.queryRefund(row.outRefundNo);
  if (gateway === null) {
    // The gateway never took it, so the request becomes executable again under
    // the same number rather than sitting in `unknown` forever.
    const missing = {
      raw: 'gateway has no such refund',
      summary: '微信支付查不到这笔退款，可以点「重试」重新发起',
    };
    await ctx.withTx((tx) => failRefund(tx, ctx, refundId, missing));
    return { status: 'failed', message: missing.summary };
  }

  if (gateway.status === 'SUCCESS') {
    // The query path reads the amount exactly as the webhook does.
    const frozenFen = Money.parse(row.amount).fen;
    if (gateway.refundFen !== frozenFen) {
      await ctx.withTx(async (tx) => {
        const locked = await repo.lockRefund(tx, refundId);
        if (!locked || locked.status === 'succeeded') return;
        await raiseRefundException(tx, ctx, locked, amountMismatch(gateway.refundFen, frozenFen));
      });
      return { status: 'unknown', message: '网关退款金额与退款单不符，待人工核对' };
    }
    await ctx.withTx((tx) =>
      settleRefundSucceeded(tx, ctx, refundId, {
        gatewayRefundId: gateway.refundId,
        source: 'query',
      }),
    );
    return { status: 'succeeded', message: '退款成功' };
  }
  if (gateway.status === 'PROCESSING') return { status: 'processing', message: '退款处理中' };

  const ended = gatewayStatusProblem(gateway.status);
  await ctx.withTx((tx) => failRefund(tx, ctx, refundId, ended));
  return { status: 'failed', message: ended.summary };
}

// ---------------------------------------------------------------------------
// the refund notification
// ---------------------------------------------------------------------------

const ACK: WebhookResult = { status: 200, body: { code: 'SUCCESS', message: '成功' } };

/**
 * `POST /api/v1/webhooks/wechat-refund`.
 *
 * Same three steps, same order, same reasons as the payment webhook: **verify
 * the signature, then insert the callback row, then act.** Nothing before the
 * verification touches the database; nothing after the insert runs twice.
 *
 * The whole body runs in one transaction, so a duplicate delivery and a racing
 * admin retry contend for the same rows instead of both booking a refund. A
 * notification whose `out_refund_no` is not one of ours is offered to the
 * payment domain, because exception refunds carry their own `X` numbers.
 *
 * Three checks after the signature, each answered 200 so WeChat stops
 * redelivering bytes that will never read any better:
 *
 *  - **the event type, before the callback row**: only `REFUND.*`. A
 *    transaction event recorded here would burn its notify id in the shared
 *    `payment_callbacks` table, and the genuine delivery to the payment webhook
 *    would read as a replay.
 *  - **the merchant**: `mchid` present and equal to the one the refund was sent
 *    under (frozen on the row; the configured one otherwise).
 *  - **the amount**: a `SUCCESS` whose `amount.refund` is absent or is not the
 *    frozen amount is not settled.
 *
 * A failed merchant or amount check leaves the refund where it was, records the
 * reason on the callback row, `refunds.last_error` and the refund's log, and
 * tells an operator (`admin_refund_exception`).
 */
export async function handleRefundNotify(
  ctx: Ctx,
  args: { headers: Record<string, string | null>; rawBody: string },
): Promise<WebhookResult> {
  const client = await payClient(ctx);
  if (!client.configured) {
    ctx.logger.error({}, 'refund notify arrived but the payment config is incomplete');
    return { status: 500, body: { code: 'FAIL', message: '支付未配置' } };
  }

  let notification;
  try {
    notification = await client.verifyNotification(args);
  } catch (error) {
    ctx.logger.warn({ err: error }, 'refund notify rejected before parsing');
    return { status: 401, body: { code: 'FAIL', message: '签名验证失败' } };
  }

  if (!notification.eventType.startsWith('REFUND.')) {
    ctx.logger.warn(
      { eventType: notification.eventType, notifyId: notification.notifyId },
      'refund notify: not a refund event; acknowledged without a callback row',
    );
    return ACK;
  }

  const resource = notification.resource;
  const outRefundNo = stringOrNull(resource.out_refund_no);
  const status = stringOrNull(resource.refund_status) ?? '';
  const gatewayRefundId = stringOrNull(resource.refund_id);
  const namedMchId = stringOrNull(resource.mchid);
  // Filed under the merchant the body named, so a foreign one is visible as such.
  const mchId = namedMchId ?? client.mchId;
  const refundFen = notifiedRefundFen(resource.amount);

  try {
    return await ctx.withTx(async (tx) => {
      const callback = await recordCallback(tx, {
        kind: callbackKind(status),
        mchId,
        providerNotifyId: notification.notifyId,
        outTradeNo: stringOrNull(resource.out_trade_no),
        transactionId: stringOrNull(resource.transaction_id),
        signatureVerified: true,
        payload: resource,
      });
      // Already recorded: WeChat is retrying an acknowledgement it never got, or
      // two deliveries raced. Either way the work is done.
      if (!callback) return ACK;

      const result =
        outRefundNo === null
          ? 'ignored: no out_refund_no'
          : await applyRefundNotification(tx, ctx, {
              outRefundNo,
              status,
              gatewayRefundId,
              namedMchId,
              configuredMchId: client.mchId,
              refundFen,
            });

      await markCallbackProcessed(tx, callback.id, { at: ctx.clock.now(), result });
      return ACK;
    });
  } catch (error) {
    // Nothing committed. FAIL asks WeChat to deliver again, which beats
    // acknowledging money we did not record.
    ctx.logger.error({ err: error, outRefundNo }, 'refund notify failed');
    return { status: 500, body: { code: 'FAIL', message: '处理失败，请重试' } };
  }
}

function callbackKind(
  status: string,
): 'refund_success' | 'refund_abnormal' | 'refund_closed' | 'unknown' {
  if (status === 'SUCCESS') return 'refund_success';
  if (status === 'ABNORMAL') return 'refund_abnormal';
  if (status === 'CLOSED') return 'refund_closed';
  return 'unknown';
}

/** Applies a *verified* refund notification inside the webhook's transaction. */
async function applyRefundNotification(
  tx: Tx,
  ctx: Ctx,
  args: {
    outRefundNo: string;
    status: string;
    gatewayRefundId: string | null;
    /** `mchid` as the body stated it; `null` when absent. */
    namedMchId: string | null;
    configuredMchId: string;
    /** `amount.refund` in 分, or `null` when absent or not a positive integer. */
    refundFen: number | null;
  },
): Promise<string> {
  const row = await repo.lockRefundByOutRefundNo(tx, args.outRefundNo);
  if (!row) {
    // Not an after-sales refund: it may be an exception refund, which the
    // payment domain owns and numbers itself. It was sent under the configured
    // merchant, so a body naming any other is not settled against it either;
    // the exception row stays `refunding`, which is on an operator's list.
    if (args.namedMchId !== args.configuredMchId) {
      ctx.logger.error(
        { outRefundNo: args.outRefundNo, mchId: args.namedMchId, expected: args.configuredMchId },
        'refund notify merchant mismatch; not settled',
      );
      return `exception: merchant_mismatch (named ${args.namedMchId ?? 'none'}, expected ${args.configuredMchId})`;
    }
    const handled = await applyExceptionRefundNotification(tx, ctx, {
      refundNo: args.outRefundNo,
      status: args.status,
      gatewayRefundId: args.gatewayRefundId,
    });
    return handled ?? `ignored: unknown refund ${args.outRefundNo}`;
  }

  const expectedMchId = row.requestContext?.mchId ?? args.configuredMchId;
  if (args.namedMchId !== expectedMchId) {
    if (row.status === 'succeeded') return 'ignored: already settled';
    const reason: RefundExceptionReason = {
      code: 'merchant_mismatch',
      message: `退款通知商户号不符：通知 ${args.namedMchId ?? '（缺失）'}，退款单 ${expectedMchId}`,
    };
    await raiseRefundException(tx, ctx, row, reason);
    return `exception: merchant_mismatch (named ${args.namedMchId ?? 'none'}, expected ${expectedMchId})`;
  }

  if (args.status === 'SUCCESS') {
    const frozenFen = Money.parse(row.amount).fen;
    if (args.refundFen !== frozenFen && row.status !== 'succeeded') {
      await raiseRefundException(tx, ctx, row, amountMismatch(args.refundFen, frozenFen));
      return `exception: amount_mismatch (notified ${args.refundFen ?? 'none'} fen, frozen ${frozenFen} fen)`;
    }
    const settled = await settleRefundSucceeded(tx, ctx, row.id, {
      gatewayRefundId: args.gatewayRefundId,
      source: 'notify',
    });
    return settled ? `refund ${row.id}: succeeded` : 'ignored: already settled';
  }

  if (args.status === 'ABNORMAL' || args.status === 'CLOSED') {
    await failRefund(tx, ctx, row.id, gatewayStatusProblem(args.status, 'notify'));
    return `refund ${row.id}: ${args.status.toLowerCase()}`;
  }

  return `ignored: refund_status=${args.status === '' ? 'null' : args.status}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `amount.refund` as WeChat states it: a positive whole number of 分, or nothing. */
function notifiedRefundFen(amount: unknown): number | null {
  const value = (amount as { refund?: unknown } | null | undefined)?.refund;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// a refund answer that does not match the refund
// ---------------------------------------------------------------------------

interface RefundExceptionReason {
  code: 'merchant_mismatch' | 'amount_mismatch';
  /** Shown on the refund (`last_error`), in its log and in the notification. */
  message: string;
}

function amountMismatch(notifiedFen: number | null, frozenFen: number): RefundExceptionReason {
  return {
    code: 'amount_mismatch',
    message:
      notifiedFen === null
        ? `网关未给出退款金额，退款单金额 ${Money.fromFen(frozenFen).toString()}`
        : `网关退款金额 ${Money.fromFen(notifiedFen).toString()} 与退款单金额 ${Money.fromFen(frozenFen).toString()} 不符`,
  };
}

/**
 * Puts a refund the gateway answered for, but not as we asked, in front of an
 * operator — and does nothing else to it.
 *
 * The status stays where it was (`processing`, `unknown`, `approved`): moving it
 * to `succeeded` would book an amount the bank disagrees with, and moving it to
 * `failed` would free the lines for a second refund of money that may well have
 * moved. `last_error`, the refund's log and `admin_refund_exception` say why.
 *
 * Idempotent on the message: the reconciliation sweep re-queries a `processing`
 * refund every few minutes, and the same discrepancy is written and announced
 * once, not once per sweep.
 */
async function raiseRefundException(
  tx: Tx,
  ctx: Ctx,
  row: repo.RefundRow,
  reason: RefundExceptionReason,
): Promise<void> {
  const message = reason.message.slice(0, 500);
  ctx.logger.error(
    { refundId: row.id, outRefundNo: row.outRefundNo, reason: reason.code, message },
    'refund answer does not match the refund; left for an operator',
  );
  if (row.lastError === message) return;

  // The discrepancy is already in staff's words, so it is its own summary.
  await repo.setLastError(tx, row.id, { raw: message, summary: message });
  // The discrepancy — which may name a merchant number — is on `last_error`
  // and in the operator's notification; the log line is fixed (REFUND-019).
  await repo.insertLog(tx, {
    refundId: row.id,
    fromStatus: row.status,
    toStatus: row.status,
    message: '退款异常，待商家核对',
  });
  await notify(tx, ctx, {
    event: REFUND_EXCEPTION_EVENT,
    subject: { scope: 'refund', id: `${row.id}:${reason.code}` },
    data: {
      refundId: row.id,
      refundNo: row.refundNo,
      amount: row.amount,
      reason: message,
    },
  });
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export type RefundItemWithSnapshot = repo.RefundItemRow & {
  snapshot: repo.OrderItemRow['snapshot'];
};

export async function detail(ctx: Ctx, refundId: number): Promise<RefundDetail> {
  const row = await repo.findRefund(ctx.db, refundId);
  if (!row) throw new DomainError('REFUND_NOT_FOUND');
  const order = await repo.findOrder(ctx.db, row.orderId);
  const [items, logs, company] = await Promise.all([
    repo.listItemsForRefunds(ctx.db, [row.id]),
    repo.listLogs(ctx.db, row.id),
    row.returnExpressCompanyId === null
      ? Promise.resolve(null)
      : repo.findExpressCompany(ctx.db, row.returnExpressCompanyId),
  ]);

  return {
    ...toListItem(
      { ...row, orderNo: order?.orderNo ?? '', userNickname: null },
      items.get(row.id) ?? [],
    ),
    ...returnDetail(row, company),
    logs: shopperLogs(logs, row),
  };
}

/**
 * The shopper's timeline: their own and the operator's words as written, the
 * system's as fixed lines, staff-only rows left out (REFUND-019).
 */
export function shopperLogs(
  logs: readonly repo.RefundLogRow[],
  refund: { amount: string; reason: string | null },
): RefundDetail['logs'] {
  return logs.flatMap((log) => {
    const message = shopperLogMessage(log, refund);
    if (message === null) return [];
    return [{ toStatus: log.toStatus, message, createdAt: log.createdAt.toISOString() }];
  });
}

type ReturnDetailFields = Pick<
  RefundDetail,
  | 'explanation'
  | 'images'
  | 'returnExpressCompanyId'
  | 'returnExpressCompanyName'
  | 'returnTrackingNo'
  | 'returnPhone'
  | 'returnAddress'
>;

/**
 * The return half of a detail.
 *
 * The address comes from `refunds.return_address`, frozen by the approval that
 * first asked this buyer to ship something back — **never** from the config
 * group. A shop that edits its return address afterwards must not silently
 * re-address a parcel that is already in the post, and a buyer holding a
 * screenshot of the old one must not be told they got it wrong.
 */
export function returnDetail(
  row: repo.RefundRow,
  company: { id: number; name: string } | null,
): ReturnDetailFields {
  const wantsAddress = row.kind === 'return_and_refund' && row.returnStage !== 'not_required';
  return {
    explanation: row.explanation,
    images: row.images,
    returnExpressCompanyId: toIdOrNull(row.returnExpressCompanyId),
    returnExpressCompanyName: company?.name ?? null,
    returnTrackingNo: row.returnTrackingNo,
    returnPhone: row.returnPhone,
    returnAddress: wantsAddress ? (row.returnAddress ?? null) : null,
  };
}

export function toLogEntry(log: repo.RefundLogRow): RefundDetail['logs'][number] {
  return {
    toStatus: log.toStatus,
    message: log.message,
    createdAt: log.createdAt.toISOString(),
  };
}

export function toListItem(
  row: repo.RefundListRow,
  items: RefundItemWithSnapshot[],
): RefundListItem {
  return {
    id: toId(row.id),
    refundNo: row.refundNo,
    orderId: toId(row.orderId),
    orderNo: row.orderNo,
    kind: row.kind,
    status: row.status,
    returnStage: row.returnStage,
    quantity: row.quantity,
    amount: row.amount,
    refundedAmount: row.refundedAmount,
    includesFreight: row.includesFreight,
    reason: row.reason,
    rejectReason: row.rejectReason,
    isAutomatic: openedByShop(row),
    items: items.map(toRefundItem),
    createdAt: row.createdAt.toISOString(),
    succeededAt: row.succeededAt === null ? null : row.succeededAt.toISOString(),
  };
}

function toRefundItem(item: RefundItemWithSnapshot): RefundItem {
  return {
    orderItemId: toId(item.orderItemId),
    productName: item.snapshot.productName,
    productImageUrl: item.snapshot.productImageUrl,
    specText: item.snapshot.specText,
    quantity: item.quantity,
    amount: item.amount,
  };
}
