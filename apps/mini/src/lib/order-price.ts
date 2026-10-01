import type { OrderDetail, OrderItem, OrderListItem } from '@shop/contracts/order/schemas';
import { fromCents, toCents } from './money';

/**
 * What an order's pages print as its prices when an activity priced it.
 *
 * A 预售 or 拼团 line keeps its catalogue `unitPrice`: checkout prices the activity as an
 * adjustment (`presale:activity-price`, `groupbuy:activity-price`) that folds into the line's
 * `discountAmount` and the order's `couponDiscount`, beside any coupon (`coupon:*`). Printed
 * straight, a ¥78 presale reads ¥88 with a ¥10「优惠券」nobody applied. The line's
 * `adjustments` tell the two apart, so the pages take the activity out of both: the line at
 * the price paid, 商品金额 after the activity, 优惠券 the coupon alone (as the uni-app does).
 */

const ACTIVITY_PRICE = /:activity-price$/;

/** The activity-price discount a line's adjustments carry, in cents (0 when none). */
export function activityDiscountCents(adjustments: OrderItem['adjustments']): number {
  return adjustments.reduce(
    (sum, adjustment) =>
      ACTIVITY_PRICE.test(adjustment.source) ? sum - toCents(adjustment.amount) : sum,
    0,
  );
}

type PricedOrder = Pick<OrderListItem, 'kind' | 'couponDiscount' | 'items'> &
  Partial<Pick<OrderDetail, 'userCouponId'>>;

function recordsAdjustments(order: PricedOrder): boolean {
  return order.items.some((item) => item.adjustments.length > 0);
}

/**
 * The activity discount of the whole order, in cents. Lines carry their adjustments; a line
 * written before they were kept carries none, and then only a single-line activity order read
 * with its `userCouponId` (订单详情) and no coupon can say: its `couponDiscount` is the
 * activity. Otherwise 0, and the pages print what the payload says.
 */
export function orderActivityCents(order: PricedOrder): number {
  if (recordsAdjustments(order)) {
    return order.items.reduce((sum, item) => sum + activityDiscountCents(item.adjustments), 0);
  }
  if (order.kind === 'normal' || order.items.length !== 1) return 0;
  if (order.userCouponId !== null) return 0; // unknown (a list row) or a coupon stacked
  return toCents(order.couponDiscount);
}

/**
 * The unit price the shopper paid for a line: `unitPrice` less its activity discount spread
 * over the quantity. A coupon does not change it (it is the order's 优惠券).
 */
export function linePaidUnitPrice(
  item: Pick<OrderItem, 'unitPrice' | 'quantity' | 'adjustments'>,
  /** The order's activity discount, for a line that carries no adjustments of its own. */
  fallbackCents = 0,
): string {
  const discount =
    item.adjustments.length > 0 ? activityDiscountCents(item.adjustments) : fallbackCents;
  if (discount <= 0) return item.unitPrice;
  const quantity = Math.max(1, item.quantity);
  const subtotal = toCents(item.unitPrice) * quantity;
  return fromCents(Math.max(0, Math.round((subtotal - discount) / quantity)));
}

export interface OrderPrices {
  /** 商品金额: `itemsAmount` after the activity price. */
  itemsAmount: string;
  /** 优惠券: `couponDiscount` without the activity. */
  couponDiscount: string;
  /** Each line's paid unit price, by line id. */
  unitPrices: Record<string, string>;
}

export function orderPrices(order: PricedOrder & Pick<OrderListItem, 'itemsAmount'>): OrderPrices {
  const activity = orderActivityCents(order);
  // Lines with adjustments price themselves; only an older single-line order hands its down.
  const fallback = recordsAdjustments(order) ? 0 : activity;
  const unitPrices: Record<string, string> = {};
  for (const item of order.items) unitPrices[item.id] = linePaidUnitPrice(item, fallback);
  if (activity <= 0) {
    return { itemsAmount: order.itemsAmount, couponDiscount: order.couponDiscount, unitPrices };
  }
  return {
    itemsAmount: fromCents(Math.max(0, toCents(order.itemsAmount) - activity)),
    couponDiscount: fromCents(Math.max(0, toCents(order.couponDiscount) - activity)),
    unitPrices,
  };
}
