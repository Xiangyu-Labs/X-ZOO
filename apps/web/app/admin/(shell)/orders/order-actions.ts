import type { AdminOrderListItem } from '@shop/contracts/order/order.fulfil.schemas';

/**
 * What the list may offer on an order, before permissions are applied.
 *
 * The rules live here rather than in the card so the list, its tests and the
 * shipping panel all agree on what 「可发货」 means. `ShipPanel` uses the same
 * helpers: a card that offers 发货 for an order the panel refuses would be a
 * button that only produces an error.
 */
export type OrderActionKind = 'ship' | 'logistics' | 'aftersale' | 'none';

type ShippableFields = Pick<
  AdminOrderListItem,
  'status' | 'fulfillmentStatus' | 'groupbuyTeamStatus' | 'items'
>;

type ActionFields = ShippableFields & Pick<AdminOrderListItem, 'refundStatus' | 'shippedAt'>;

/** 拼团 not yet 成团: paid, but not to be shipped. */
export function teamForming(order: Pick<AdminOrderListItem, 'groupbuyTeamStatus'>): boolean {
  return order.groupbuyTeamStatus !== null && order.groupbuyTeamStatus !== 'succeeded';
}

/**
 * At least one unit is still waiting to go out, on a line that an operator
 * ships by hand. 卡密 and 优惠券 lines are delivered by the system after payment
 * and never enter a shipment.
 */
export function hasShippableLine(order: Pick<AdminOrderListItem, 'items'>): boolean {
  return order.items.some(
    (item) =>
      item.quantity - item.shippedQuantity - item.refundedQuantity > 0 &&
      (item.productKind === 'physical' || item.productKind === 'virtual_manual'),
  );
}

/** Paid, not fully sent, not waiting for a 拼团, and with something to send. */
export function shippableOrder(order: ShippableFields): boolean {
  return (
    order.status === 'paid' &&
    order.fulfillmentStatus !== 'fulfilled' &&
    !teamForming(order) &&
    hasShippableLine(order)
  );
}

/**
 * The one action the card offers (before permissions):
 *
 *  - an open after-sales wins over everything: that is the thing to look at;
 *  - 待发货 with something to send → 发货;
 *  - goods that left the warehouse (but the order is not finished/refunded/
 *    cancelled) → 物流详情;
 *  - 待付款, 已完成, 已退款, 已取消 → nothing.
 *
 * An order shipped in part has no `shippedAt` yet; it stays 发货 until the last
 * unit goes, which is what the operator needs to do next.
 */
export function orderActionOf(order: ActionFields): OrderActionKind {
  if (order.refundStatus === 'requested') return 'aftersale';
  if (shippableOrder(order)) return 'ship';
  if (
    order.shippedAt !== null &&
    order.status !== 'completed' &&
    order.status !== 'refunded' &&
    order.status !== 'cancelled'
  ) {
    return 'logistics';
  }
  return 'none';
}
