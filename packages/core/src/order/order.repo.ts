import type { DbOrTx, Tx } from '@shop/db';
import { cartItems } from '@shop/db/schema/cart';
import { productReviews } from '@shop/db/schema/catalog';
import { refunds } from '@shop/db/schema/refund';
import { orderItems, orderStatusLogs, orders } from '@shop/db/schema/order';
import { userAddresses } from '@shop/db/schema/user';
import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  allOf,
  conditionalDelete,
  conditionalUpdate,
  type ConditionalUpdateResult,
} from '../kernel/tx';
import type { OrderListTab } from '@shop/contracts/order/schemas';
import type { OrderStatus } from './ports';
import { containsPattern } from '../kernel/like';

/**
 * The only file in the order domain that touches Drizzle tables.
 *
 * Statements, not decisions: every `if` about an affected row count lives in a
 * service. The two things worth reading closely are `transitionStatus` (one
 * guarded UPDATE, the whole state machine) and the idempotency pair at the
 * bottom, which is how a double submit is stopped by the database rather than
 * by a cache lock.
 */

/** Re-exported so a service can type a snapshot without importing the schema. */
export type { OrderItemSnapshot } from '@shop/db/schema/order';

export type OrderRow = typeof orders.$inferSelect;
export type NewOrderValues = typeof orders.$inferInsert;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type NewOrderItemValues = typeof orderItems.$inferInsert;
export type AddressRow = typeof userAddresses.$inferSelect;

/** Visible to its owner: not hidden by the buyer, not soft-deleted by an operator. */
const liveForUser = (): SQL | undefined =>
  and(isNull(orders.hiddenByUserAt), isNull(orders.deletedAt));

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export async function findOrder(db: DbOrTx, id: number): Promise<OrderRow | null> {
  const rows = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * A stranger and an unknown id are the same answer, deliberately: telling the
 * caller "this order exists but is not yours" is an enumeration oracle
 * (AUTH-005).
 */
export async function findOrderForUser(
  db: DbOrTx,
  args: { id: number; userId: number },
): Promise<OrderRow | null> {
  const rows = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, args.id), eq(orders.userId, args.userId), liveForUser()))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * `SELECT … FOR UPDATE` on the order row.
 *
 * Cancellation needs it because it spans several rows that must agree — the
 * order, its coupon, its stock — and because `PaymentPort.ensureNoOpenAttempts`
 * is asked *while holding it*, so a payment cannot start underneath a
 * cancellation.
 */
export async function lockOrder(tx: Tx, id: number): Promise<OrderRow | null> {
  const rows = await tx.select().from(orders).where(eq(orders.id, id)).limit(1).for('update');
  return rows[0] ?? null;
}

export async function statusOf(db: DbOrTx, id: number): Promise<OrderStatus | null> {
  const rows = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, id));
  const status = rows[0]?.status;
  return status === undefined ? null : status;
}

export async function listItems(db: DbOrTx, orderIds: readonly number[]): Promise<OrderItemRow[]> {
  if (orderIds.length === 0) return [];
  return db
    .select()
    .from(orderItems)
    .where(inArray(orderItems.orderId, [...new Set(orderIds)]))
    .orderBy(asc(orderItems.id));
}

/** What the `StockPort` has to give back on a cancellation. */
export async function stockLinesOf(
  db: DbOrTx,
  orderId: number,
): Promise<{ skuId: number; quantity: number }[]> {
  return db
    .select({ skuId: orderItems.skuId, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.skuId));
}

/**
 * Which of these order lines already have a review: any `product_reviews` row, published,
 * 待审核 or soft-deleted by the shop, because `product_reviews_order_item_uq` refuses a
 * second review in every one of those cases.
 *
 * A named cross-domain read, like the auto-review sweep's join in `order.facts.repo.ts`: the
 * alternative is a round trip through the catalog for a set of ids this domain already has.
 */
export async function reviewedItemIds(
  db: DbOrTx,
  itemIds: readonly number[],
): Promise<Set<number>> {
  if (itemIds.length === 0) return new Set();
  const rows = await db
    .select({ orderItemId: productReviews.orderItemId })
    .from(productReviews)
    .where(inArray(productReviews.orderItemId, [...new Set(itemIds)]));
  return new Set(rows.flatMap((row) => (row.orderItemId === null ? [] : [row.orderItemId])));
}

/**
 * Units of each product this buyer has already committed to, for a `lifetime`
 * purchase limit — the one definition checkout, the cart and the product page
 * all read (`OrderFactsPort.purchasedQuantity` is this, for one product).
 *
 * An unpaid order counts: it holds the units until it is paid or closed, and
 * not counting it would let a shopper open three unpaid orders under a limit of
 * one and pay all three. A cancelled order does not count, and neither do
 * refunded units — a shopper who abandoned a checkout or sent the goods back
 * has not used up their allowance.
 */
export async function purchasedQuantity(
  db: DbOrTx,
  args: { userId: number; productIds: readonly number[] },
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (args.productIds.length === 0) return out;
  const rows = await db
    .select({
      productId: orderItems.productId,
      quantity: sql<number>`coalesce(sum(${orderItems.quantity} - ${orderItems.refundedQuantity}), 0)::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orders.userId, args.userId),
        ne(orders.status, 'cancelled'),
        inArray(orderItems.productId, [...new Set(args.productIds)]),
      ),
    )
    .groupBy(orderItems.productId);
  for (const row of rows) out.set(row.productId, Number(row.quantity));
  return out;
}

/**
 * 退款中: an after-sales request on the order is still being handled. Read from
 * `refunds` itself, never from `orders.refund_status`: that roll-up says
 * `partially_refunded` for good once any money went back, open request or not.
 * A `failed` refund counts: it still holds its lines until the merchant retries
 * or closes it.
 */
export function hasOpenRefund(): SQL {
  return sql`exists (select 1 from ${refunds} where ${refunds.orderId} = ${orders.id} and ${inArray(refunds.status, [...OPEN_REFUND_STATUSES])})`;
}

/**
 * The refund domain's `IN_FLIGHT_STATUSES`, spelled out: that domain imports
 * this one, so importing it back would be a cycle. `order.open-refund.test.ts`
 * holds the two lists equal.
 */
export const OPEN_REFUND_STATUSES = [
  'applied',
  'approved',
  'processing',
  'unknown',
  'failed',
] as const;

/** Which of these orders have an after-sales request still being handled. */
export async function ordersWithOpenRefund(
  db: DbOrTx,
  orderIds: readonly number[],
): Promise<Set<number>> {
  if (orderIds.length === 0) return new Set();
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(inArray(orders.id, [...new Set(orderIds)]), hasOpenRefund()));
  return new Set(rows.map((row) => row.id));
}

/** Whether one order has an after-sales request still being handled. */
export async function orderHasOpenRefund(db: DbOrTx, orderId: number): Promise<boolean> {
  const [row] = await db
    .select({ open: sql<boolean>`${hasOpenRefund()}` })
    .from(orders)
    .where(eq(orders.id, orderId));
  return row?.open === true;
}

/**
 * The storefront's tabs are not `orders.status` values — 待收货 covers
 * `shipped`, 已完成 covers `received` *and* `completed` — so the mapping lives
 * here, once, and the list and the badges can never disagree about what 待发货
 * means.
 */
export function tabFilter(tab: OrderListTab): SQL | undefined {
  switch (tab) {
    case 'unpaid':
      return eq(orders.status, 'pending_payment');
    case 'unshipped':
      return eq(orders.status, 'paid');
    case 'shipping':
      return and(eq(orders.status, 'paid'), eq(orders.fulfillmentStatus, 'partially_fulfilled'));
    case 'unreceived':
      return eq(orders.status, 'shipped');
    case 'finished':
      return inArray(orders.status, ['received', 'completed']);
    case 'cancelled':
      return eq(orders.status, 'cancelled');
    case 'refunding':
      return hasOpenRefund();
    case 'unreviewed':
      return awaitingReview();
    default:
      return undefined;
  }
}

/**
 * 待评价 (ORDER-010): `received` or `completed`, with a line not refunded in full and not yet
 * reviewed — `isReviewable` in `order.query.service.ts`, in SQL, and what `catalog.reviewSubmit`
 * accepts. Reads `product_reviews` for the same reason as `reviewedItemIds`.
 */
export function awaitingReview(): SQL {
  return sql`(${orders.status} in ('received', 'completed') and exists (
    select 1 from order_items oi
    where oi.order_id = ${orders.id}
      and oi.refunded_quantity < oi.quantity
      and not exists (select 1 from product_reviews pr where pr.order_item_id = oi.id)
  ))`;
}

export interface OrderListFilter {
  userId: number;
  where?: SQL | undefined;
  keyword?: string | undefined;
  sortBy?: 'createdAt' | 'payableAmount' | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
  offset: number;
  limit: number;
}

export async function listOrders(
  db: DbOrTx,
  filter: OrderListFilter,
): Promise<{ rows: OrderRow[]; total: number }> {
  const keyword = filter.keyword?.trim();
  const where = allOf(
    eq(orders.userId, filter.userId),
    liveForUser(),
    filter.where,
    keyword
      ? or(
          sql`${orders.orderNo} like ${containsPattern(keyword)}`,
          sql`exists (select 1 from order_items oi where oi.order_id = ${orders.id} and oi.snapshot->>'productName' ilike ${containsPattern(keyword)})`,
        )
      : undefined,
  );

  const column = filter.sortBy === 'payableAmount' ? orders.payableAmount : orders.createdAt;
  const direction = filter.sortOrder === 'asc' ? asc : desc;

  const rows = await db
    .select()
    .from(orders)
    .where(where)
    .orderBy(direction(column), desc(orders.id))
    .limit(filter.limit)
    .offset(filter.offset);

  const counted = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(orders)
    .where(where);

  return { rows, total: Number(counted[0]?.total ?? 0) };
}

/**
 * One grouped query behind all the badges, rather than a `count(*)` each. `unreviewed` is
 * the group's 待评价 orders (`awaitingReview`).
 */
export async function countByStatus(
  db: DbOrTx,
  userId: number,
): Promise<
  {
    status: OrderStatus;
    fulfillmentStatus: string;
    refunding: number;
    n: number;
    unreviewed: number;
  }[]
> {
  const rows = await db
    .select({
      status: orders.status,
      fulfillmentStatus: orders.fulfillmentStatus,
      n: sql<number>`count(*)::int`,
      refunding: sql<number>`(count(*) filter (where ${hasOpenRefund()}))::int`,
      unreviewed: sql<number>`(count(*) filter (where ${awaitingReview()}))::int`,
    })
    .from(orders)
    .where(and(eq(orders.userId, userId), liveForUser()))
    .groupBy(orders.status, orders.fulfillmentStatus);
  return rows.map((row) => ({
    ...row,
    n: Number(row.n),
    refunding: Number(row.refunding),
    unreviewed: Number(row.unreviewed),
  }));
}

/**
 * Orders whose payment window has closed. The partial index
 * `orders_pay_expires_idx (pay_expires_at) WHERE status = 'pending_payment'`
 * exists for exactly this query.
 */
export async function listExpiredUnpaid(
  db: DbOrTx,
  args: { now: Date; limit: number },
): Promise<number[]> {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, 'pending_payment'),
        lte(orders.payExpiresAt, args.now),
        isNull(orders.deletedAt),
      ),
    )
    .orderBy(asc(orders.payExpiresAt))
    .limit(args.limit);
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// cart lines
// ---------------------------------------------------------------------------

/**
 * The two `cart_items` statements checkout owns.
 *
 * They live here, in the order domain, rather than behind `cart/index.ts`, for
 * one reason: the dependency between the two domains has to point one way, and
 * it points **cart -> order** (the cart reads live catalogue data through
 * `order/catalog.port.ts`, and 再次购买 reads an order). Letting checkout call
 * back into `cart/index.ts` would close the loop and make the two module graphs
 * circular. A `*.repo.ts` is the one kind of file allowed to import
 * `@shop/db/schema/*`, and these are two statements — so the seam costs less
 * than the cycle would.
 */
export interface CartLine {
  cartItemId: number;
  skuId: number;
  quantity: number;
}

/**
 * The rows a checkout is built from. An empty `cartItemIds` means "everything
 * the shopper has ticked", which is what the 结算 button sends.
 */
export async function selectCartLines(
  db: DbOrTx,
  args: { userId: number; cartItemIds: readonly number[] },
): Promise<CartLine[]> {
  return db
    .select({
      cartItemId: cartItems.id,
      skuId: cartItems.skuId,
      quantity: cartItems.quantity,
    })
    .from(cartItems)
    .where(
      and(
        eq(cartItems.userId, args.userId),
        args.cartItemIds.length > 0
          ? inArray(cartItems.id, [...new Set(args.cartItemIds)])
          : eq(cartItems.isSelected, true),
      ),
    )
    .orderBy(asc(cartItems.id));
}

/** Empties the rows an order consumed, inside that order's transaction. */
export async function deleteCartLines(
  tx: Tx,
  args: { userId: number; cartItemIds: readonly number[] },
): Promise<number> {
  if (args.cartItemIds.length === 0) return 0;
  const { affected } = await conditionalDelete(
    tx,
    cartItems,
    and(eq(cartItems.userId, args.userId), inArray(cartItems.id, [...new Set(args.cartItemIds)])),
  );
  return affected;
}

// ---------------------------------------------------------------------------
// addresses (the user domain's table; read-only here)
// ---------------------------------------------------------------------------

export async function findAddress(
  db: DbOrTx,
  args: { id: number; userId: number },
): Promise<AddressRow | null> {
  const rows = await db
    .select()
    .from(userAddresses)
    .where(
      and(
        eq(userAddresses.id, args.id),
        eq(userAddresses.userId, args.userId),
        isNull(userAddresses.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findDefaultAddress(db: DbOrTx, userId: number): Promise<AddressRow | null> {
  const rows = await db
    .select()
    .from(userAddresses)
    .where(
      and(
        eq(userAddresses.userId, userId),
        eq(userAddresses.isDefault, true),
        isNull(userAddresses.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

export async function insertOrder(tx: Tx, values: NewOrderValues): Promise<OrderRow> {
  const rows = await tx.insert(orders).values(values).returning();
  return rows[0]!;
}

export async function insertOrderItems(
  tx: Tx,
  values: readonly NewOrderItemValues[],
): Promise<OrderItemRow[]> {
  if (values.length === 0) return [];
  return tx
    .insert(orderItems)
    .values([...values])
    .returning();
}

/**
 * The state machine's single statement.
 *
 * `from` is a list, and it is in the WHERE — that is the whole safety
 * property. A caller that read the status first and passed what it saw would
 * be writing a read-then-write with extra steps.
 */
export async function transitionStatus(
  tx: Tx,
  args: {
    orderId: number;
    from: readonly OrderStatus[];
    to: OrderStatus;
    set: Record<string, unknown>;
  },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, orders, {
    where: and(eq(orders.id, args.orderId), inArray(orders.status, [...args.from])),
    set: { ...args.set, updatedAt: sql`now()` },
  });
}

/**
 * 删除订单, which has never deleted anything: the buyer's own list stops
 * showing the order and the shop's copy is untouched.
 *
 * Everything that decides the answer is in the WHERE — the owner, the statuses
 * a finished order may be in, and `hidden_by_user_at IS NULL`. Two taps of the
 * button therefore have exactly one winner, and a refund landing between a read
 * and this write cannot leave an in-flight order hidden.
 */
export async function hideFromUser(
  tx: Tx,
  args: { orderId: number; userId: number; from: readonly OrderStatus[]; at: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, orders, {
    where: and(
      eq(orders.id, args.orderId),
      eq(orders.userId, args.userId),
      inArray(orders.status, [...args.from]),
      isNull(orders.hiddenByUserAt),
      isNull(orders.deletedAt),
      // A 已完成 order can still have an after-sales request open.
      sql`not ${hasOpenRefund()}`,
    ),
    set: { hiddenByUserAt: args.at, updatedAt: sql`now()` },
  });
}

export type StatusLogValues = typeof orderStatusLogs.$inferInsert;

export async function insertStatusLog(tx: Tx, values: StatusLogValues): Promise<void> {
  await tx.insert(orderStatusLogs).values(values);
}

export async function countStatusLogs(
  db: DbOrTx,
  args: { orderId: number; changeType: StatusLogValues['changeType'] },
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orderStatusLogs)
    .where(
      and(
        eq(orderStatusLogs.orderId, args.orderId),
        eq(orderStatusLogs.changeType, args.changeType),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

/**
 * "Second submit returns the first order", built on a UNIQUE index.
 *
 * A lock key in Redis would be gone after a restart and have no relationship to
 * the transaction it is supposed to protect. A UNIQUE column does not:
 *
 *     idempotency_key varchar(64)
 *     UNIQUE (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
 *
 * So there is no claim step any more. The key is inserted *with* the order, and
 * the index does the whole job:
 *
 *  - a concurrent duplicate **blocks** on the index entry until the first
 *    transaction settles;
 *  - if that one committed, ours raises `23505` and the winner's order is
 *    readable by `(user_id, idempotency_key)`;
 *  - if it rolled back, the entry is dead and our insert simply goes through,
 *    which is what lets a key be retried after a failed submit.
 *
 * The partial index is what keeps an order created by an admin, an import or
 * any future non-storefront path — all of which have no key — from colliding
 * on NULL.
 */
/**
 * What the loser of the race reads, once the winner has committed — whether
 * the index refused its insert (23505 on `orders_idempotency_uq`) or it failed
 * earlier, on a cart the winner had already emptied.
 */
export async function findOrderIdByIdempotencyKey(
  db: DbOrTx,
  args: { userId: number; key: string },
): Promise<number | null> {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.userId, args.userId), eq(orders.idempotencyKey, args.key)))
    .limit(1);
  return rows[0]?.id ?? null;
}
