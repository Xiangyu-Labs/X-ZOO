import { registerEffectHandler } from '../effects';
import { onOrderCancelled, onOrderCompleted, onOrderPaid, onOrderRefunded } from '../order/ports';
import { registerFulfilmentNotifier, type FulfilmentNoticeShipment } from '../order';
import { AVATAR_REJECTED_EVENT, onAvatarRejected } from '../user';
import {
  fanOut,
  notify,
  NOTIFICATION_EVENT_TYPE,
  NOTIFICATION_SCOPE,
} from './notification.service';
import { formatShopTime } from './notification.render';
import { settledRefundNote } from './notification.registry';

/**
 * Where notifications hook into the rest of the system.
 *
 * Two kinds of seam, and the difference is about who owns the transaction:
 *
 * - **Order hooks** (`onOrderPaid`, `onOrderCancelled`, …) run *inside* the
 *   business transaction, which is exactly where `notify` belongs: the effect
 *   row and the state change commit together, so a rolled-back payment leaves
 *   no "payment received" message behind and a committed one can never lose the
 *   notification.
 * - **`FulfilmentNotifier`** (fulfilment's port) is called *after* commit, from
 *   fulfilment's own effect handler, because shipping's notification is already
 *   behind the ledger. There `notify` opens a short transaction of its own; the
 *   effect key makes the second call free, so fulfilment retrying its handler
 *   does not enqueue a second notification.
 *
 * Everything here is registered from `installNotificationHooks()` rather than
 * at module scope, because `resetOrderPorts()` in an integration test clears
 * every hook registry, and a hook registered at module scope would not come
 * back.
 */

registerEffectHandler(NOTIFICATION_SCOPE, NOTIFICATION_EVENT_TYPE, async (ctx, effect) => {
  await fanOut(ctx, effect);
});

export function installNotificationHooks(): void {
  onAvatarRejected(async (tx, ctx, event) => {
    await notify(tx, ctx, {
      event: AVATAR_REJECTED_EVENT,
      subject: { scope: 'content-security-check', id: event.checkId },
      userId: event.userId,
      data: {},
    });
  });

  onOrderPaid.register('notification:order-paid', async (tx, ctx, event) => {
    const data = {
      orderId: event.orderId,
      orderNo: event.orderNo,
      amount: event.paidAmount.toString(),
      paidAt: formatShopTime(event.at, 'minute'),
    };
    await notify(tx, ctx, {
      event: 'order_paid',
      subject: { scope: 'order', id: event.orderId },
      userId: event.userId,
      data,
    });
    await notify(tx, ctx, {
      event: 'admin_order_paid',
      subject: { scope: 'order', id: event.orderId },
      data,
    });
  });

  onOrderCancelled.register('notification:order-cancelled', async (tx, ctx, event) => {
    await notify(tx, ctx, {
      event: 'order_cancelled',
      subject: { scope: 'order', id: event.orderId },
      userId: event.userId,
      data: {
        orderId: event.orderId,
        orderNo: event.orderNo,
        reason: CANCEL_REASONS[event.reason],
      },
    });
  });

  onOrderCompleted.register('notification:order-completed', async (tx, ctx, event) => {
    await notify(tx, ctx, {
      event: 'order_completed',
      subject: { scope: 'order', id: event.orderId },
      userId: event.userId,
      data: { orderId: event.orderId, orderNo: event.orderNo },
    });
  });

  onOrderRefunded.register('notification:order-refunded', async (tx, ctx, event) => {
    // The refund domain fires this once per settled refund, partial or not, so
    // the key carries the refund id rather than the order id: two partial
    // refunds of one order are two notifications, and the same refund settled
    // twice by a replayed callback is one.
    await notify(tx, ctx, {
      event: 'refund_settled',
      subject: { scope: 'refund', id: event.refundId },
      userId: event.userId,
      data: {
        refundId: event.refundId,
        refundNo: event.refundNo ?? '',
        orderNo: event.orderNo,
        amount: event.refundedAmount.toString(),
        refundNote: settledRefundNote(event.refundedAmount.toString()),
      },
    });
  });

  registerFulfilmentNotifier({
    async notify(ctx, notice) {
      const event = FULFILMENT_EVENTS[notice.kind];
      if (event === undefined) return;
      const { shipment } = notice;
      const data = {
        orderId: notice.orderId,
        orderNo: notice.order?.orderNo ?? '',
        amount: notice.order?.paidAmount ?? '',
      };
      await ctx.withTx(async (tx) => {
        await notify(tx, ctx, {
          event,
          // A dispatch is keyed on its parcel, not the order: an order shipped
          // in parts is told about each parcel and each tracking number, and
          // the same parcel retried is still told once (NOTIF-002).
          subject:
            shipment === null
              ? { scope: 'order', id: notice.orderId }
              : { scope: 'shipment', id: shipment.id },
          userId: notice.userId,
          data: { ...data, ...(shipment === null ? {} : deliveryVariables(shipment)) },
        });
        // 用户确认收货提醒 was offered in 消息管理 and never sent (NOTIF-009).
        if (notice.kind === 'order.received') {
          await notify(tx, ctx, {
            event: 'admin_order_received',
            subject: { scope: 'order', id: notice.orderId },
            data,
          });
        }
      });
    },
  });
}

/**
 * What `order_shipped` says about the parcel, for each way it can travel.
 *
 * `company` and `trackingNo` are a courier's, and only an express parcel has
 * them; `deliveryInfo` is the one sentence that reads right for all three, and
 * is what the default wording uses (NOTIF-007).
 */
export function deliveryVariables(shipment: FulfilmentNoticeShipment): Record<string, string> {
  if (shipment.deliveryMode === 'express') {
    const company = shipment.expressCompanyName ?? '';
    const trackingNo = shipment.trackingNo ?? '';
    return {
      company,
      trackingNo,
      deliveryInfo: [company, trackingNo === '' ? '' : `运单号 ${trackingNo}`]
        .filter((part) => part !== '')
        .join(' '),
    };
  }
  if (shipment.deliveryMode === 'merchant_delivery') {
    const courier = [shipment.courierName ?? '', shipment.courierPhone ?? '']
      .filter((part) => part !== '')
      .join(' ');
    return {
      company: '商家配送',
      trackingNo: '',
      courierName: shipment.courierName ?? '',
      courierPhone: shipment.courierPhone ?? '',
      deliveryInfo: courier === '' ? '由商家配送' : `由商家配送，配送员 ${courier}`,
    };
  }
  return {
    company: '虚拟发货',
    trackingNo: '',
    deliveryInfo: '虚拟商品已发放，可在订单详情中查看',
  };
}

/**
 * `virtual.delivered` maps onto `order_shipped` rather than getting an event of
 * its own: from the buyer's side a card key arriving *is* the delivery, and a
 * separate 虚拟发货 template would be one more thing for an operator to
 * configure and forget.
 */
const FULFILMENT_EVENTS: Record<string, string | undefined> = {
  'shipment.dispatched': 'order_shipped',
  'virtual.delivered': 'order_shipped',
  'order.received': 'order_received',
  'order.completed': 'order_completed',
};

const CANCEL_REASONS: Record<string, string> = {
  user: '买家取消',
  timeout: '超时未付款',
  admin: '后台取消',
  'payment-failed': '支付失败',
};

/**
 * **`installNotificationHooks()` is deliberately not called here.**
 *
 * The checkout and the order console call `notify`, so `order/index.ts` and
 * `notification/index.ts` are a cycle, and a cycle entered from the order side
 * reaches this module's body while `../order` is still evaluating — at which
 * point `registerFulfilmentNotifier` is not yet a function and the whole app
 * fails to import. What a bundler or a transform does with a re-exported
 * binding mid-cycle is not something to rely on.
 *
 * `registerNotificationDomain()` in `index.ts` calls it instead, from
 * `@shop/core/domains` at bootstrap, which is where registration belongs and
 * which runs after every module has been evaluated. The `registerEffectHandler`
 * above stays at module scope on purpose: it depends on nothing outside this
 * domain, and the integration tests import this file precisely to get it.
 */

/** Imported for its side effects; this keeps a bundler from eliding the module. */
export const notificationEffectsInstalled = true;
