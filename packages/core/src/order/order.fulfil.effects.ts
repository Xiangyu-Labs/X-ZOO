import { registerEffectHandler, recordEffect, type Effect } from '../effects';
import type { Ctx } from '../kernel/context';
import { SummarizedError } from '../kernel/error-summary';
import { generateOrderNo } from '../kernel/ids';
import { Money } from '../kernel/money';
import { grantOrderGifts } from '../coupon';
import { orderFulfilConfig } from './order.fulfil.config';
import * as fulfilRepo from './order.fulfil.repo';
import * as rules from './order.fulfil.rules';
import { resolveFulfilmentNotifier, type FulfilmentNoticeShipment } from './order.fulfil.ports';
import { readyToShip, scheduleAutoReceive } from './order.fulfil.service';
import * as repo from './order.repo';
import { onOrderPaid, onShipmentDispatched } from './ports';
import { orderStateMachine } from './order.state-machine';

/**
 * What happens to an order *after* somebody pays for it, on fulfilment's side.
 *
 * Two rules shape this whole file:
 *
 *  1. **The paid hook writes one row and nothing else.** `onOrderPaid` runs
 *     inside the payment transaction, and everything it does can roll a
 *     payment back. Claiming a card key, granting coupons and creating a
 *     shipment are all things that can legitimately fail (the shop ran out of
 *     cards), and none of them is worth failing a payment over. So the hook
 *     records one effect and returns; the ledger runs the delivery afterwards,
 *     retries it with backoff, and parks it for a human if the shop really is
 *     out of stock — while the order sits in 待发货 where an operator can see
 *     it.
 *  2. **Every handler is idempotent.** Delivery is at-least-once, so the
 *     handler takes the order lock and refuses to run twice by looking for its
 *     own timeline entry.
 */

const VIRTUAL_DELIVERY = 'order.auto-deliver';

// ---------------------------------------------------------------------------
// the paid hook
// ---------------------------------------------------------------------------

/**
 * A function rather than a bare statement, because `resetOrderPorts()` clears
 * every hook registry: an integration test that resets the ports between cases
 * would otherwise silently lose auto-delivery for the rest of the file. Called
 * once on import, and again by anything that resets.
 */
export function installFulfilmentHooks(): void {
  onOrderPaid.register('order:auto-deliver', async (tx, ctx, event) => {
    await recordEffect(tx, ctx, {
      scope: 'order',
      scopeId: String(event.orderId),
      eventType: VIRTUAL_DELIVERY,
      payload: {
        orderId: event.orderId,
        userId: event.userId,
        paidAmount: event.paidAmount.toString(),
      },
    });
  });
}

installFulfilmentHooks();

interface AutoDeliverPayload {
  orderId: number;
  userId: number;
  paidAmount: string;
}

function payloadOf(effect: Effect): AutoDeliverPayload {
  const raw = effect.payload as Partial<AutoDeliverPayload> | null;
  const orderId = Number(raw?.orderId ?? effect.scopeId);
  return {
    orderId,
    userId: Number(raw?.userId ?? 0),
    paidAmount: String(raw?.paidAmount ?? '0.00'),
  };
}

export interface AutoDeliverOutcome {
  delivered: boolean;
  /** The delivery also finished the order, so it moved `paid -> shipped`. */
  fulfilled: boolean;
  shipmentId: number | null;
  couponsGranted: number;
  /** Lines that wanted a card key and did not get one. */
  shortOfCards: number[];
}

/**
 * Hands over everything the system can hand over by itself: card keys and
 * coupons.
 *
 * `virtual_manual` is deliberately *not* here — that kind of "虚拟商品" is a
 * thing a human does something about (an account is topped up, a service is
 * booked), and auto-shipping it would tell the buyer it was delivered when
 * nobody had touched it. It goes out through the normal 发货 button with
 * `deliveryMode: 'virtual'`.
 *
 * Exported so a test can call it directly rather than through the dispatcher.
 */
export async function autoDeliver(ctx: Ctx, orderId: number): Promise<AutoDeliverOutcome> {
  const empty: AutoDeliverOutcome = {
    delivered: false,
    fulfilled: false,
    shipmentId: null,
    couponsGranted: 0,
    shortOfCards: [],
  };
  const now = ctx.clock.now();

  const outcome = await ctx.withTx(async (tx): Promise<AutoDeliverOutcome> => {
    const order = await repo.lockOrder(tx, orderId);
    if (!order) return empty;
    // A refund can beat delivery to the order. Nothing to hand over then.
    if (order.status !== 'paid') return empty;
    // RISK-D-011: a 拼团 order waits for its team; the team's success calls this again.
    if (!(await readyToShip(tx, order))) return empty;

    // The idempotence gate. The ledger replays, and the two writes below
    // (shipped_quantity, claimed cards) are not things to do twice.
    const already = await repo.countStatusLogs(tx, { orderId, changeType: 'virtual_delivered' });
    if (already > 0) return empty;

    const lines = await fulfilRepo.lockLineProgress(tx, orderId);
    const auto = lines.filter(
      (line) =>
        (line.productKind === 'virtual_card' || line.productKind === 'virtual_coupon') &&
        rules.outstandingOf(line) > 0,
    );

    // Gift coupons: the products bought plus every active 满额赠券 template.
    // Idempotent through `user_coupons_order_gift_uq`, so a replay grants
    // nothing more.
    const { granted } = await grantOrderGifts(tx, ctx, {
      userId: order.userId,
      orderId,
      productIds: [...new Set(lines.map((line) => line.productId))],
      paidAmount: order.paidAmount === null ? Money.ZERO : Money.parse(order.paidAmount),
    });

    if (auto.length === 0) {
      return { ...empty, couponsGranted: granted };
    }

    const delivered: { orderItemId: number; quantity: number }[] = [];
    const shortOfCards: number[] = [];
    const notes: string[] = [];

    for (const line of auto) {
      if (line.productKind === 'virtual_coupon') {
        delivered.push({ orderItemId: line.orderItemId, quantity: rules.outstandingOf(line) });
        notes.push(`${line.itemKey}: 优惠券已发放至账户`);
        continue;
      }
      // `product_virtual_cards_order_item_uq` is one card per line, so a
      // card-key line is a one-card line. A quantity above 1 is a checkout
      // defect; the buyer still gets their card and the operator sees the
      // warning rather than a silently half-delivered order.
      const existing = await fulfilRepo.findClaimedCard(tx, line.orderItemId);
      const card =
        existing ??
        (await fulfilRepo.claimVirtualCard(tx, {
          skuId: line.skuId,
          orderItemId: line.orderItemId,
          userId: order.userId,
          at: now,
        }));
      if (!card) {
        shortOfCards.push(line.orderItemId);
        continue;
      }
      if (line.quantity > 1) {
        ctx.logger.warn(
          { orderId, orderItemId: line.orderItemId, quantity: line.quantity },
          'card-key line with quantity > 1; one card issued',
        );
      }
      delivered.push({ orderItemId: line.orderItemId, quantity: rules.outstandingOf(line) });
      notes.push(
        card.cardSecret === null
          ? `${line.itemKey}: 卡号 ${card.cardNo}`
          : `${line.itemKey}: 卡号 ${card.cardNo} 密码 ${card.cardSecret}`,
      );
    }

    if (shortOfCards.length > 0) {
      // Throwing hands the row back to the ledger, which retries with backoff
      // and eventually parks it. Nothing written so far survives.
      const short = `卡密库存不足，订单 ${order.orderNo} 的 ${shortOfCards.length} 个商品行无法发货`;
      throw new SummarizedError(short, short);
    }

    const shipment = await fulfilRepo.insertShipment(tx, {
      orderId,
      shipmentNo: generateOrderNo(ctx.clock, { prefix: 'SV' }),
      deliveryMode: 'virtual',
      status: 'dispatched',
      virtualContent: notes.join('\n'),
      dispatchedAt: now,
    });
    await fulfilRepo.insertShipmentItems(
      tx,
      delivered.map((line) => ({
        shipmentId: shipment.id,
        orderItemId: line.orderItemId,
        quantity: line.quantity,
      })),
    );
    for (const line of delivered) {
      const bumped = await fulfilRepo.bumpShippedQuantity(tx, {
        orderItemId: line.orderItemId,
        orderId,
        quantity: line.quantity,
      });
      if (!bumped.won) {
        throw new Error(`自动发货写入失败: order_item ${line.orderItemId}`);
      }
    }

    const rollUp = rules.rollUpFulfillment(rules.applyPlan(lines, delivered));
    await fulfilRepo.setFulfillmentStatus(tx, {
      orderId,
      from: ['unfulfilled', 'partially_fulfilled'],
      to: rollUp,
    });
    if (rollUp === 'fulfilled') {
      // On `tx`: the card rows and the order row are held here, and a second
      // pooled connection could wait on them.
      const { autoReceiveDays } = await ctx.config.getIn(tx, orderFulfilConfig);
      await orderStateMachine.transition(tx, orderId, ['paid'], 'shipped', {
        at: now,
        autoReceiveAt: new Date(now.getTime() + autoReceiveDays * 86_400_000),
      });
    }

    await repo.insertStatusLog(tx, {
      orderId,
      changeType: 'virtual_delivered',
      fromStatus: 'paid',
      toStatus: rollUp === 'fulfilled' ? 'shipped' : 'paid',
      message: '系统自动发货',
      operatorKind: 'system',
    });

    await recordEffect(tx, ctx, {
      scope: 'shipment',
      scopeId: String(shipment.id),
      eventType: 'shipment.dispatched',
      payload: { orderId, userId: order.userId, shipmentId: shipment.id },
    });

    await onShipmentDispatched.dispatch(tx, ctx, {
      orderId,
      orderNo: order.orderNo,
      userId: order.userId,
      at: now,
      shipmentId: shipment.id,
      deliveryMode: 'virtual',
      allDelivered: rollUp === 'fulfilled',
      otherShipments: (await fulfilRepo.listShipments(tx, [orderId]))
        .filter((other) => other.id !== shipment.id)
        .map((other) => ({ id: other.id, cancelled: other.status === 'cancelled' })),
    });

    return {
      delivered: true,
      fulfilled: rollUp === 'fulfilled',
      shipmentId: shipment.id,
      couponsGranted: granted,
      shortOfCards: [],
    };
  });

  if (outcome.delivered) {
    if (outcome.fulfilled) {
      const { autoReceiveDays } = await ctx.config.get(orderFulfilConfig);
      await scheduleAutoReceive(ctx, orderId, autoReceiveDays);
    }
    ctx.logger.info({ orderId, shipmentId: outcome.shipmentId }, 'order auto-delivered');
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

registerEffectHandler('order', VIRTUAL_DELIVERY, async (ctx, effect) => {
  await autoDeliver(ctx, payloadOf(effect).orderId);
});

/**
 * "你的包裹已发出".
 *
 * Behind the ledger because it leaves the building. With no notifier registered
 * this logs and succeeds, on purpose: parking one `unknown` effect row per
 * shipment would give an operator a queue of rows they cannot act on, which is
 * worse than no notification at all.
 */
registerEffectHandler('shipment', 'shipment.dispatched', async (ctx, effect) => {
  await notify(ctx, effect, 'shipment.dispatched');
});

registerEffectHandler('order', 'order.received', async (ctx, effect) => {
  await notify(ctx, effect, 'order.received');
});

registerEffectHandler('order', 'order.completed', async (ctx, effect) => {
  await notify(ctx, effect, 'order.completed');
});

/**
 * The effect rows carry ids only (`{ orderId, userId, shipmentId? }`), and
 * rows of that shape are already in the ledger. So what the message says —
 * the order number, the carrier, the tracking number — is read here, when the
 * handler runs, from this domain's own tables: an old row and a new one say
 * the same thing, and a tracking number corrected through 修改发货信息 before
 * the send goes out is the corrected one (NOTIF-007).
 *
 * A shipment cancelled before the handler got to it is not announced.
 */
async function notify(
  ctx: Ctx,
  effect: Effect,
  kind: 'shipment.dispatched' | 'order.received' | 'order.completed',
): Promise<void> {
  const notifier = resolveFulfilmentNotifier();
  const payload = (effect.payload ?? {}) as {
    orderId?: number;
    userId?: number;
    shipmentId?: number;
  };
  if (!notifier) {
    ctx.logger.debug({ kind, effectId: effect.id }, 'no fulfilment notifier registered');
    return;
  }
  const orderId = Number(payload.orderId ?? 0);
  const order = await repo.findOrder(ctx.db, orderId);

  let shipment: FulfilmentNoticeShipment | null = null;
  if (kind === 'shipment.dispatched') {
    const shipmentId = Number(payload.shipmentId ?? effect.scopeId);
    const row = await fulfilRepo.findShipment(ctx.db, shipmentId);
    if (row?.status === 'cancelled') {
      ctx.logger.info({ shipmentId, effectId: effect.id }, 'shipment cancelled before its notice');
      return;
    }
    if (row) {
      const company =
        row.expressCompanyId === null
          ? null
          : await fulfilRepo.findExpressCompanyEvenDisabled(ctx.db, row.expressCompanyId);
      shipment = {
        id: row.id,
        deliveryMode: row.deliveryMode,
        expressCompanyName: company?.name ?? null,
        trackingNo: row.trackingNo,
        courierName: row.courierName,
        courierPhone: row.courierPhone,
      };
    }
  }

  await notifier.notify(ctx, {
    kind,
    orderId,
    userId: Number(payload.userId ?? order?.userId ?? 0),
    payload: (effect.payload ?? {}) as Record<string, unknown>,
    order: order ? { orderNo: order.orderNo, paidAmount: order.paidAmount } : null,
    shipment,
  });
}

/** Imported for its side effects; this keeps a bundler from eliding the module. */
export const orderFulfilEffectsInstalled = true;
