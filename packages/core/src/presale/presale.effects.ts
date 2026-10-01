import type { Tx } from '@shop/db';
import type { Ctx } from '../kernel/context';
import { registerEffectHandler, type Effect } from '../effects/index';
import { formatShopTime, notify } from '../notification';
import { refundSystemInitiated } from '../refund';
import { PRESALE_EVENTS, refundNoteOf } from './presale.notifications';
import * as repo from './presale.repo';

/**
 * What the presale domain does *after* the transaction commits.
 *
 * Anything that calls a third party happens after commit, via the effects
 * ledger — never inside the transaction. A 预售发货提醒 sent from inside the
 * order-paid path would let a WeChat timeout roll back a payment that had
 * genuinely landed, so there is no flag and no exception: every notification is
 * an effect, always.
 *
 * Five event types, all recorded in `presale.order.ts` and `presale.jobs.ts`:
 *
 * | scope     | event_type         | when                                            |
 * | --------- | ------------------ | ----------------------------------------------- |
 * | `order`   | `presale.paid`     | a presale order was paid; 发货承诺 is now fixed |
 * | `order`   | `presale.released` | a cancel or refund gave the campaign units back |
 * | `order`   | `presale.refund`   | the shop owes money nobody asked it for         |
 * | `presale` | `presale.opened`   | a campaign's sale window opened                 |
 * | `presale` | `presale.closed`   | a campaign's sale window closed                 |
 *
 * `presale.paid` and `presale.refund` are where the shopper hears about it —
 * see `presale.notifications.ts`. `presale.refund` also moves money, through
 * the refund domain's own entry point. The other three have nobody to tell:
 * see `nobodyToTell` below.
 */

// ---------------------------------------------------------------------------
// the system-initiated refund
// ---------------------------------------------------------------------------

/**
 * How a presale gives the money back.
 *
 * The default is `refundSystemInitiated` from `refund/index.ts`, declared the
 * same way as group buy's. The port exists because a unit test that wants to
 * watch the effect handler should not have to stand up a paid order, a payment
 * attempt and a refundable line; `registerAutoRefundPort` lets it substitute a
 * spy.
 *
 * What it is *not* is an extension point: the only registration outside a test
 * is the default below, and anything that opens a `refunds` row still goes
 * through the refund domain's own entry point, ceiling check and all.
 *
 * Presale needs it for one case, and it is a case that involves a shopper's
 * money: `total_quota` is a ceiling on units **sold** and sales are counted
 * when the money arrives (STOCK-004), so a payment can be refused by a quota
 * that filled while it was in flight. The order is not rolled back — the money
 * is already ours — so it has to be given back.
 */
export interface AutoRefundPort {
  refund(
    tx: Tx,
    ctx: Ctx,
    input: { orderId: number; reason: 'presale_expired'; note?: string },
  ): Promise<{ refundId: number; created: boolean }>;
}

const defaultAutoRefundPort: AutoRefundPort = {
  refund: (tx, ctx, input) => refundSystemInitiated(tx, ctx, input),
};

let autoRefundPort: AutoRefundPort = defaultAutoRefundPort;

export function registerAutoRefundPort(port: AutoRefundPort): void {
  autoRefundPort = port;
}

/** Test helper: puts the real refund entry point back. */
export function clearAutoRefundPort(): void {
  autoRefundPort = defaultAutoRefundPort;
}

export function peekAutoRefundPort(): AutoRefundPort {
  return autoRefundPort;
}

interface RefundPayload {
  orderId: string;
  activityId: string;
  reason: string;
}

/**
 * Gives a shopper their money back when the campaign could not sell to them.
 *
 * The transaction is opened here rather than by the payment that recorded the
 * effect, because the payment's own transaction had to commit: the money
 * arrived, and `presale_stock_ledger` had to record the units going back
 * whatever the refund does afterwards. `UNIQUE (scope, scope_id, event_type)`
 * gives exactly one effect per order however many payment callbacks arrive,
 * and `refundSystemInitiated` is idempotent per `(orderId, reason)` on top of
 * that, so a retried effect finds the refund it already opened and returns it
 * instead of opening a second. The shopper's notice is recorded in the same
 * transaction, so it exists exactly when the refund does.
 *
 * A throw here is still the right failure: the dispatcher retries eight times
 * and then parks the row as `unknown`, where the 待处理任务 console lists it
 * (it filters `scope in ('payment','refund','order')`, and this effect's scope
 * is `order`) and an operator settles it by hand. Swallowing the error would
 * lose a shopper's money quietly.
 */
async function handleRefundEffect(ctx: Ctx, effect: Effect): Promise<void> {
  const payload = effect.payload as RefundPayload;
  const orderId = Number(payload.orderId);
  const port = autoRefundPort;
  const result = await ctx.withTx(async (tx) => {
    const refund = await port.refund(tx, ctx, {
      orderId,
      reason: 'presale_expired',
      note: `预售活动 ${payload.activityId} 限购总量已满，无法发货`,
    });
    await notifySoldOut(tx, ctx, { orderId, refundId: refund.refundId });
    return refund;
  });
  ctx.logger.info(
    {
      orderId: payload.orderId,
      activityId: payload.activityId,
      refundId: String(result.refundId),
      created: result.created,
    },
    'presale: a payment the campaign could not honour was refunded',
  );
}

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

/**
 * 预售付款成功, with the ship date the payment fixed.
 *
 * Read at dispatch time: `presale_orders.ship_not_before_at` is frozen onto the
 * order in the payment's transaction, so it is there by now, and an order that
 * has left `final_paid` since (cancelled, refunded) is not told it will ship.
 * `notify` keys the notice on the order, so a retried effect sends nothing twice.
 */
async function handlePaidEffect(ctx: Ctx, effect: Effect): Promise<void> {
  const payload = effect.payload as { orderId: string };
  const notice = await repo.findOrderNotice(ctx.db, Number(payload.orderId));
  if (!notice || notice.stage !== 'final_paid' || notice.shipNotBeforeAt === null) return;
  const shipDate = formatShopTime(notice.shipNotBeforeAt, 'day');

  await ctx.withTx((tx) =>
    notify(tx, ctx, {
      event: PRESALE_EVENTS.paid,
      subject: { scope: 'order', id: notice.orderId },
      userId: notice.userId,
      data: {
        orderId: notice.orderId,
        orderNo: notice.orderNo,
        activityTitle: notice.activityTitle,
        amount: notice.paidAmount ?? '',
        shipDate,
      },
    }),
  );
}

/**
 * 预售名额已满, inside the transaction that opened the refund. The amount is
 * what the shopper paid: nothing of a presale order ships before its payment
 * stands, so the system refund gives back all of it.
 */
async function notifySoldOut(
  tx: Tx,
  ctx: Ctx,
  args: { orderId: number; refundId: number },
): Promise<void> {
  const notice = await repo.findOrderNotice(tx, args.orderId);
  if (!notice) return;
  await notify(tx, ctx, {
    event: PRESALE_EVENTS.soldOut,
    subject: { scope: 'order', id: notice.orderId },
    userId: notice.userId,
    data: {
      orderId: notice.orderId,
      orderNo: notice.orderNo,
      activityTitle: notice.activityTitle,
      amount: notice.paidAmount ?? '',
      refundNote: refundNoteOf(notice.paidAmount),
      refundId: args.refundId,
    },
  });
}

/**
 * The effects that tell nobody anything.
 *
 * - `presale.released` follows a cancel or a refund, and the shopper already
 *   hears about both from the order domain (订单取消提醒, 退款到账提醒). A
 *   second message saying the campaign got its units back would be about the
 *   shop's bookkeeping, not their order.
 * - `presale.opened` and `presale.closed` are about a campaign, and a campaign
 *   has no audience: there is no 预约提醒 list of shoppers waiting for it.
 *
 * They still get a handler, because an unhandled effect retries eight times and
 * then parks as `unknown` in the operators' 待处理任务 console, where nobody can
 * act on it. The rows stay in the ledger as the record of what happened.
 */
async function nobodyToTell(): Promise<void> {}

/** Idempotent; `registerEffectHandler` replaces by `(scope, eventType)`. */
export function registerPresaleEffects(): void {
  registerEffectHandler('order', 'presale.paid', handlePaidEffect);
  registerEffectHandler('order', 'presale.released', nobodyToTell);
  registerEffectHandler('order', 'presale.refund', handleRefundEffect);
  registerEffectHandler('presale', 'presale.opened', nobodyToTell);
  registerEffectHandler('presale', 'presale.closed', nobodyToTell);
}
