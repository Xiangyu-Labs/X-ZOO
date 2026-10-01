import { productReviews } from '@shop/db/schema/catalog';
import { orderItems, orders } from '@shop/db/schema/order';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';

import type { OrderFactsPort, ReviewableLine } from './ports';
import { purchasedQuantity } from './order.repo';

/**
 * The order domain's answers to the catalog's questions — `OrderFactsPort` —
 * here, because this is where a read of `orders` belongs. Everything is a read.
 *
 * One deliberate cross-domain touch remains: `findLinesAwaitingReview` joins
 * `product_reviews` to skip lines the shopper (or an earlier sweep) already
 * reviewed. The alternative — hand the catalog a cursor and let it filter —
 * would make the sweep re-scan the same already-reviewed page forever, so the
 * join stays and is named here rather than hidden.
 */

/** `snapshot` carries the variant label the buyer actually saw. */
interface OrderItemSnapshotShape {
  specText?: string;
}

function specTextOf(snapshot: unknown): string {
  if (typeof snapshot === 'object' && snapshot !== null) {
    const text = (snapshot as OrderItemSnapshotShape).specText;
    if (typeof text === 'string') return text;
  }
  return '';
}

export const orderFacts: OrderFactsPort = {
  async findReviewableLine(tx, args): Promise<ReviewableLine | null> {
    const rows = await tx
      .select({
        orderId: orders.id,
        orderItemId: orderItems.id,
        productId: orderItems.productId,
        skuId: orderItems.skuId,
        snapshot: orderItems.snapshot,
        userId: orders.userId,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orderItems.id, args.orderItemId),
          // Ownership is part of the WHERE, not an `if` afterwards: a stranger
          // gets the same `null` as a missing line.
          eq(orders.userId, args.userId),
          sql`${orders.status} in ('received', 'completed')`,
          // A line refunded in full was never really received.
          sql`${orderItems.refundedQuantity} < ${orderItems.quantity}`,
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      orderId: row.orderId,
      orderItemId: row.orderItemId,
      productId: row.productId,
      skuId: row.skuId,
      specText: specTextOf(row.snapshot),
      userId: row.userId,
    };
  },

  async purchasedQuantity(tx, args): Promise<number> {
    // The checkout's own count, so the cart, the product page and 提交订单 can
    // never disagree about how much of a lifetime limit is left.
    const counted = await purchasedQuantity(tx, {
      userId: args.userId,
      productIds: [args.productId],
    });
    return counted.get(args.productId) ?? 0;
  },

  /**
   * Keyed on `completed_at`, which the state machine stamps on the
   * `received -> completed` transition (the fulfilment sweep or the shopper's
   * own confirmation), so "N days after completion" means exactly that and not
   * "N days since anything last touched the row".
   */
  async findLinesAwaitingReview(tx, args): Promise<ReviewableLine[]> {
    const rows = await tx
      .select({
        orderId: orders.id,
        orderItemId: orderItems.id,
        productId: orderItems.productId,
        skuId: orderItems.skuId,
        snapshot: orderItems.snapshot,
        userId: orders.userId,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .leftJoin(productReviews, eq(productReviews.orderItemId, orderItems.id))
      .where(
        and(
          eq(orders.status, 'completed'),
          lte(orders.completedAt, args.completedBefore),
          isNull(productReviews.id),
          sql`${orderItems.refundedQuantity} < ${orderItems.quantity}`,
        ),
      )
      .orderBy(asc(orderItems.id))
      .limit(args.limit);

    return rows.map((row) => ({
      orderId: row.orderId,
      orderItemId: row.orderItemId,
      productId: row.productId,
      skuId: row.skuId,
      specText: specTextOf(row.snapshot),
      userId: row.userId,
    }));
  },

  async hasOpenOrders(tx, productId): Promise<boolean> {
    const rows = await tx
      .select({ id: orderItems.id })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orderItems.productId, productId),
          sql`${orders.status} in ('pending_payment', 'paid', 'shipped', 'received')`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  },
};
