import type { DbOrTx, Tx } from '@shop/db';
import { productVirtualCards } from '@shop/db/schema/catalog';
import {
  orderInvoices,
  orderItems,
  orderStatusLogs,
  orders,
  shipmentItems,
  shipments,
} from '@shop/db/schema/order';
import { admins } from '@shop/db/schema/auth';
import { expressCompanies } from '@shop/db/schema/reference';
import { refunds } from '@shop/db/schema/refund';
import { users } from '@shop/db/schema/user';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  isNotNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { allOf, conditionalUpdate, type ConditionalUpdateResult } from '../kernel/tx';
import { hasOpenRefund } from './order.repo';
import type { OrderStatus } from './ports';
import { containsPattern } from '../kernel/like';

/**
 * Every Drizzle statement fulfilment owns. `order.repo.ts` keeps the checkout
 * and cancellation statements; the two files never overlap, so a change to one
 * flow cannot silently alter a statement the other depends on.
 *
 * Statements, not decisions — with one thing worth reading twice.
 * `bumpShippedQuantity` carries the fulfilment invariant in its WHERE clause:
 *
 * ```sql
 * UPDATE order_items SET shipped_quantity = shipped_quantity + $q
 *  WHERE id = $1 AND shipped_quantity + $q <= quantity - refunded_quantity
 * ```
 *
 * Zero affected rows is the *only* correct way to learn that a line cannot take
 * another `$q` units. Reading the quantity, subtracting in application code and
 * writing the result back would let two operators pressing 发货 together ship
 * the same units twice, and a refund landing mid-form ship goods that had
 * already been refunded. There is no read here at all.
 *
 * ## Tables from other domains, read-only
 *
 * Four tables are read here that fulfilment does not own, the same way checkout
 * reads `user_addresses`:
 *
 * | Table                   | Owner    | Why                                         |
 * | ----------------------- | -------- | ------------------------------------------- |
 * | `users`                 | user     | the buyer's name and phone on a console row |
 * | `refunds`               | refund   | the 退款 link on the order detail (ids only) |
 * | `express_companies`     | shipping | the 发货 form's company picker              |
 * | `product_virtual_cards` | catalog  | claiming one card key per paid order item   |
 *
 * All four are SELECTs except the card claim, which is the conditional UPDATE
 * `packages/db/src/schema/catalog.ts` documents as the intended one.
 */

export type ShipmentRow = typeof shipments.$inferSelect;
export type NewShipmentValues = typeof shipments.$inferInsert;
export type ShipmentItemRow = typeof shipmentItems.$inferSelect;
export type OrderInvoiceRow = typeof orderInvoices.$inferSelect;
export type NewOrderInvoiceValues = typeof orderInvoices.$inferInsert;
export type ExpressCompanyRow = typeof expressCompanies.$inferSelect;

export type FulfillmentStatus = 'unfulfilled' | 'partially_fulfilled' | 'fulfilled';

// ---------------------------------------------------------------------------
// shipments
// ---------------------------------------------------------------------------

export async function findShipment(db: DbOrTx, id: number): Promise<ShipmentRow | null> {
  const rows = await db.select().from(shipments).where(eq(shipments.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listShipments(
  db: DbOrTx,
  orderIds: readonly number[],
): Promise<ShipmentRow[]> {
  if (orderIds.length === 0) return [];
  return db
    .select()
    .from(shipments)
    .where(inArray(shipments.orderId, [...new Set(orderIds)]))
    .orderBy(asc(shipments.id));
}

export async function listShipmentItems(
  db: DbOrTx,
  shipmentIds: readonly number[],
): Promise<ShipmentItemRow[]> {
  if (shipmentIds.length === 0) return [];
  return db
    .select()
    .from(shipmentItems)
    .where(inArray(shipmentItems.shipmentId, [...new Set(shipmentIds)]))
    .orderBy(asc(shipmentItems.id));
}

/**
 * `created_at` is the moment of the insert, under the order lock the caller
 * holds, not the transaction's start: a 仅退款 approval compares it with the
 * request's own `created_at` to tell goods shipped before the buyer asked from
 * goods shipped after (REFUND-021).
 */
export async function insertShipment(tx: Tx, values: NewShipmentValues): Promise<ShipmentRow> {
  const rows = await tx
    .insert(shipments)
    .values({ ...values, createdAt: sql`clock_timestamp()` })
    .returning();
  return rows[0]!;
}

export async function insertShipmentItems(
  tx: Tx,
  values: readonly { shipmentId: number; orderItemId: number; quantity: number }[],
): Promise<void> {
  if (values.length === 0) return;
  await tx.insert(shipmentItems).values([...values]);
}

/**
 * The fulfilment invariant, as one statement.
 *
 * FULFILL-002: `shipped_quantity` never exceeds `quantity - refunded_quantity`.
 * Both ends are in the WHERE, so a refund committed a microsecond ago is
 * accounted for without this code ever reading it, and two simultaneous ships
 * of the same unit end with exactly one winner.
 */
export async function bumpShippedQuantity(
  tx: Tx,
  args: { orderItemId: number; orderId: number; quantity: number },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, orderItems, {
    where: and(
      eq(orderItems.id, args.orderItemId),
      eq(orderItems.orderId, args.orderId),
      sql`${orderItems.shippedQuantity} + ${args.quantity} <= ${orderItems.quantity} - ${orderItems.refundedQuantity}`,
    ),
    set: {
      shippedQuantity: sql`${orderItems.shippedQuantity} + ${args.quantity}`,
      updatedAt: sql`now()`,
    },
  });
}

/** 撤销发货 puts the units back. Guarded so it can never drive the column negative. */
export async function releaseShippedQuantity(
  tx: Tx,
  args: { orderItemId: number; quantity: number },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, orderItems, {
    where: and(
      eq(orderItems.id, args.orderItemId),
      sql`${orderItems.shippedQuantity} >= ${args.quantity}`,
    ),
    set: {
      shippedQuantity: sql`${orderItems.shippedQuantity} - ${args.quantity}`,
      updatedAt: sql`now()`,
    },
  });
}

export interface LineProgress {
  orderItemId: number;
  quantity: number;
  shippedQuantity: number;
  refundedQuantity: number;
  productKind: string;
  skuId: number;
  productId: number;
  itemKey: string;
}

/**
 * Every line's progress, with `FOR UPDATE` on the item rows.
 *
 * Shipping has to decide against *all* the lines at once (does this dispatch
 * finish the order?), so the rows must agree — `docs/conventions.md`'s "use
 * `lockRow` when several rows must agree". The per-line write is still a
 * conditional update; the lock only serialises the roll-up decision.
 */
export async function lockLineProgress(tx: Tx, orderId: number): Promise<LineProgress[]> {
  const rows = await tx
    .select({
      orderItemId: orderItems.id,
      quantity: orderItems.quantity,
      shippedQuantity: orderItems.shippedQuantity,
      refundedQuantity: orderItems.refundedQuantity,
      snapshot: orderItems.snapshot,
      skuId: orderItems.skuId,
      productId: orderItems.productId,
      itemKey: orderItems.itemKey,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id))
    .for('update');
  return rows.map((row) => ({
    orderItemId: row.orderItemId,
    quantity: row.quantity,
    shippedQuantity: row.shippedQuantity,
    refundedQuantity: row.refundedQuantity,
    productKind: row.snapshot.productKind,
    skuId: row.skuId,
    productId: row.productId,
    itemKey: row.itemKey,
  }));
}

/** Same rows without the lock, for the read paths. */
export async function readLineProgress(db: DbOrTx, orderId: number): Promise<LineProgress[]> {
  const rows = await db
    .select({
      orderItemId: orderItems.id,
      quantity: orderItems.quantity,
      shippedQuantity: orderItems.shippedQuantity,
      refundedQuantity: orderItems.refundedQuantity,
      snapshot: orderItems.snapshot,
      skuId: orderItems.skuId,
      productId: orderItems.productId,
      itemKey: orderItems.itemKey,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id));
  return rows.map((row) => ({
    orderItemId: row.orderItemId,
    quantity: row.quantity,
    shippedQuantity: row.shippedQuantity,
    refundedQuantity: row.refundedQuantity,
    productKind: row.snapshot.productKind,
    skuId: row.skuId,
    productId: row.productId,
    itemKey: row.itemKey,
  }));
}

/**
 * Moves `orders.fulfillment_status`, conditionally on where it is now.
 *
 * `orders_fulfillment_matches_status` is a CHECK, so this never runs on an
 * order whose `status` has already left `paid` — the service decides the target
 * from the locked line progress and then asserts it here.
 */
export async function setFulfillmentStatus(
  tx: Tx,
  args: { orderId: number; from: readonly FulfillmentStatus[]; to: FulfillmentStatus },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, orders, {
    where: and(eq(orders.id, args.orderId), inArray(orders.fulfillmentStatus, [...args.from])),
    set: { fulfillmentStatus: args.to, updatedAt: sql`now()` },
  });
}

export async function cancelShipmentRow(
  tx: Tx,
  args: { shipmentId: number; at: Date; remark: string | null },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, shipments, {
    where: and(eq(shipments.id, args.shipmentId), eq(shipments.status, 'dispatched')),
    set: {
      status: 'cancelled',
      cancelledAt: args.at,
      ...(args.remark === null ? {} : { remark: args.remark }),
      updatedAt: sql`now()`,
    },
  });
}

export async function updateShipmentInfo(
  tx: Tx,
  args: { shipmentId: number; set: Record<string, unknown> },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, shipments, {
    where: and(eq(shipments.id, args.shipmentId), eq(shipments.status, 'dispatched')),
    set: { ...args.set, updatedAt: sql`now()` },
  });
}

/** Marks every live shipment of an order delivered, when the buyer confirms receipt. */
export async function markShipmentsDelivered(
  tx: Tx,
  args: { orderId: number; at: Date },
): Promise<number> {
  const result = await conditionalUpdate(tx, shipments, {
    where: and(eq(shipments.orderId, args.orderId), eq(shipments.status, 'dispatched')),
    set: { status: 'delivered', deliveredAt: args.at, updatedAt: sql`now()` },
  });
  return result.affected;
}

// ---------------------------------------------------------------------------
// express companies (the shipping domain's reference data)
// ---------------------------------------------------------------------------

export async function listExpressCompanies(db: DbOrTx): Promise<ExpressCompanyRow[]> {
  return db
    .select()
    .from(expressCompanies)
    .where(eq(expressCompanies.isEnabled, true))
    .orderBy(desc(expressCompanies.sortOrder), asc(expressCompanies.id));
}

/**
 * The company a shipment names, enabled or not: a carrier retired after the
 * parcel left is still the carrier that took it.
 */
export async function findExpressCompanyEvenDisabled(
  db: DbOrTx,
  id: number,
): Promise<ExpressCompanyRow | null> {
  const rows = await db.select().from(expressCompanies).where(eq(expressCompanies.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findExpressCompany(
  db: DbOrTx,
  id: number,
): Promise<ExpressCompanyRow | null> {
  const rows = await db
    .select()
    .from(expressCompanies)
    .where(and(eq(expressCompanies.id, id), eq(expressCompanies.isEnabled, true)))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// card keys (the catalog's table; the claim the schema comment specifies)
// ---------------------------------------------------------------------------

/**
 * Claims one unclaimed card for an order item.
 *
 * `FOR UPDATE SKIP LOCKED` inside the subquery, so two concurrent paid effects
 * on two orders never pick the same card and never queue behind each other;
 * `product_virtual_cards_order_item_uq` means a *retry* of the same effect
 * cannot claim a second card for the same line. Returns the claimed card or
 * `null` when the shop has run out.
 */
export async function claimVirtualCard(
  tx: Tx,
  args: { skuId: number; orderItemId: number; userId: number; at: Date },
): Promise<{ cardKey: string; cardNo: string; cardSecret: string | null } | null> {
  const rows = await tx
    .update(productVirtualCards)
    .set({
      state: 'claimed',
      orderItemId: args.orderItemId,
      claimedByUserId: args.userId,
      claimedAt: args.at,
      updatedAt: sql`now()`,
    })
    .where(
      sql`${productVirtualCards.id} = (
        select id from product_virtual_cards
         where sku_id = ${args.skuId} and state = 'unclaimed'
         order by id limit 1 for update skip locked)`,
    )
    .returning({
      cardKey: productVirtualCards.cardKey,
      cardNo: productVirtualCards.cardNo,
      cardSecret: productVirtualCards.cardSecret,
    });
  return rows[0] ?? null;
}

/** The card already claimed for this line, so a ledger retry is a quiet no-op. */
export async function findClaimedCard(
  db: DbOrTx,
  orderItemId: number,
): Promise<{ cardKey: string; cardNo: string; cardSecret: string | null } | null> {
  const rows = await db
    .select({
      cardKey: productVirtualCards.cardKey,
      cardNo: productVirtualCards.cardNo,
      cardSecret: productVirtualCards.cardSecret,
    })
    .from(productVirtualCards)
    .where(eq(productVirtualCards.orderItemId, orderItemId))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// the timeline
// ---------------------------------------------------------------------------

export interface StatusLogRow {
  id: number;
  changeType: (typeof orderStatusLogs.$inferSelect)['changeType'];
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  message: string | null;
  operatorKind: (typeof orderStatusLogs.$inferSelect)['operatorKind'];
  operatorName: string | null;
  createdAt: Date;
}

export async function listStatusLogs(db: DbOrTx, orderId: number): Promise<StatusLogRow[]> {
  return db
    .select({
      id: orderStatusLogs.id,
      changeType: orderStatusLogs.changeType,
      fromStatus: orderStatusLogs.fromStatus,
      toStatus: orderStatusLogs.toStatus,
      message: orderStatusLogs.message,
      operatorKind: orderStatusLogs.operatorKind,
      operatorName: sql<string | null>`coalesce(${admins.name}, ${users.nickname})`,
      createdAt: orderStatusLogs.createdAt,
    })
    .from(orderStatusLogs)
    .leftJoin(admins, eq(admins.id, orderStatusLogs.operatorAdminId))
    .leftJoin(users, eq(users.id, orderStatusLogs.operatorUserId))
    .where(eq(orderStatusLogs.orderId, orderId))
    .orderBy(desc(orderStatusLogs.id));
}

// ---------------------------------------------------------------------------
// the console list
// ---------------------------------------------------------------------------

export interface AdminOrderFilter {
  status?: readonly OrderStatus[] | undefined;
  fulfillmentStatus?: readonly FulfillmentStatus[] | undefined;
  refundStatus?: readonly ('none' | 'requested' | 'partially_refunded' | 'refunded')[] | undefined;
  refunding?: boolean | undefined;
  kind?: 'normal' | 'groupbuy' | 'presale' | undefined;
  platform?: 'h5' | 'wechat_oa' | 'wechat_mini' | undefined;
  keyword?: string | undefined;
  userId?: number | undefined;
  createdFrom?: Date | undefined;
  createdTo?: Date | undefined;
  paidFrom?: Date | undefined;
  paidTo?: Date | undefined;
  deleted: boolean;
}

export type OrderRow = typeof orders.$inferSelect;

function adminWhere(filter: AdminOrderFilter): SQL | undefined {
  const keyword = filter.keyword?.trim();
  return allOf(
    filter.deleted ? isNotNull(orders.deletedAt) : isNull(orders.deletedAt),
    filter.status?.length ? inArray(orders.status, [...filter.status]) : undefined,
    filter.fulfillmentStatus?.length
      ? inArray(orders.fulfillmentStatus, [...filter.fulfillmentStatus])
      : undefined,
    filter.refundStatus?.length
      ? inArray(orders.refundStatus, [...filter.refundStatus])
      : undefined,
    filter.refunding === undefined
      ? undefined
      : filter.refunding
        ? hasOpenRefund()
        : sql`not ${hasOpenRefund()}`,
    filter.kind ? eq(orders.kind, filter.kind) : undefined,
    filter.platform ? eq(orders.platform, filter.platform) : undefined,
    filter.userId === undefined ? undefined : eq(orders.userId, filter.userId),
    filter.createdFrom ? gte(orders.createdAt, filter.createdFrom) : undefined,
    filter.createdTo ? lte(orders.createdAt, filter.createdTo) : undefined,
    filter.paidFrom ? gte(orders.paidAt, filter.paidFrom) : undefined,
    filter.paidTo ? lte(orders.paidAt, filter.paidTo) : undefined,
    keyword
      ? or(
          sql`${orders.orderNo} like ${containsPattern(keyword)}`,
          sql`${orders.receiverName} ilike ${containsPattern(keyword)}`,
          sql`${orders.receiverPhone} like ${containsPattern(keyword)}`,
          sql`exists (select 1 from order_items oi where oi.order_id = ${orders.id} and oi.snapshot->>'productName' ilike ${containsPattern(keyword)})`,
        )
      : undefined,
  );
}

export type AdminSortKey = 'id' | 'createdAt' | 'paidAt' | 'payableAmount';

export async function listAdminOrders(
  db: DbOrTx,
  args: {
    filter: AdminOrderFilter;
    sortBy?: AdminSortKey | undefined;
    sortOrder?: 'asc' | 'desc' | undefined;
    offset: number;
    limit: number;
  },
): Promise<{ rows: OrderRow[]; total: number }> {
  const where = adminWhere(args.filter);
  const column =
    args.sortBy === 'paidAt'
      ? orders.paidAt
      : args.sortBy === 'payableAmount'
        ? orders.payableAmount
        : args.sortBy === 'id'
          ? orders.id
          : orders.createdAt;
  const direction = args.sortOrder === 'asc' ? asc : desc;

  const rows = await db
    .select()
    .from(orders)
    .where(where)
    .orderBy(direction(column), desc(orders.id))
    .limit(args.limit)
    .offset(args.offset);

  const counted = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(orders)
    .where(where);
  return { rows, total: Number(counted[0]?.total ?? 0) };
}

/** The export reads the same filter without paging, bounded by `limit`. */
export async function listAdminOrdersForExport(
  db: DbOrTx,
  args: { filter: AdminOrderFilter; limit: number },
): Promise<OrderRow[]> {
  return db
    .select()
    .from(orders)
    .where(adminWhere(args.filter))
    .orderBy(desc(orders.id))
    .limit(args.limit);
}

export async function countAdminOrders(db: DbOrTx, filter: AdminOrderFilter): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(orders)
    .where(adminWhere(filter));
  return Number(rows[0]?.total ?? 0);
}

export interface UserBriefRow {
  id: number;
  nickname: string | null;
  avatarUrl: string | null;
  phone: string | null;
}

/** The user domain's table, read-only — the same arrangement checkout has with `user_addresses`. */
export async function listUserBriefs(
  db: DbOrTx,
  userIds: readonly number[],
): Promise<UserBriefRow[]> {
  if (userIds.length === 0) return [];
  return db
    .select({
      id: users.id,
      nickname: users.nickname,
      avatarUrl: users.avatarUrl,
      phone: users.phone,
    })
    .from(users)
    .where(inArray(users.id, [...new Set(userIds)]));
}

/** The refund domain's table, read-only: the console links to its pages, it never writes a refund. */
export async function listRefundIds(
  db: DbOrTx,
  orderIds: readonly number[],
): Promise<{ orderId: number; id: number }[]> {
  if (orderIds.length === 0) return [];
  return db
    .select({ orderId: refunds.orderId, id: refunds.id })
    .from(refunds)
    .where(inArray(refunds.orderId, [...new Set(orderIds)]))
    .orderBy(desc(refunds.id));
}

/** Which of these orders have a live invoice request, for the console's 发票 column. */
export async function listOpenInvoiceStatuses(
  db: DbOrTx,
  orderIds: readonly number[],
): Promise<{ orderId: number; status: OrderInvoiceRow['status'] }[]> {
  if (orderIds.length === 0) return [];
  return db
    .select({ orderId: orderInvoices.orderId, status: orderInvoices.status })
    .from(orderInvoices)
    .where(inArray(orderInvoices.orderId, [...new Set(orderIds)]))
    .orderBy(desc(orderInvoices.id));
}

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

export interface RangeTotals {
  orderCount: number;
  paidOrderCount: number;
  paidAmount: string;
  refundedAmount: string;
}

/** The window's totals, counted the way 交易统计 counts them. */
export async function rangeTotals(
  db: DbOrTx,
  args: { from: Date; to: Date },
): Promise<RangeTotals> {
  // The populations 交易统计 uses: placed in the window by `created_at`, paid
  // in it by `paid_at`, refunded in it by the refund's `succeeded_at` — each
  // over orders an operator has not deleted, `to` exclusive.
  const placed = and(gte(orders.createdAt, args.from), lt(orders.createdAt, args.to));
  const paid = and(gte(orders.paidAt, args.from), lt(orders.paidAt, args.to));
  const [rows, refunded] = await Promise.all([
    db
      .select({
        orderCount: sql<number>`count(*) filter (where ${placed})::int`,
        paidOrderCount: sql<number>`count(*) filter (where ${paid})::int`,
        paidAmount: sql<string>`coalesce(sum(${orders.paidAmount}) filter (where ${paid}), 0)::text`,
      })
      .from(orders)
      .where(and(isNull(orders.deletedAt), or(placed, paid))),
    db
      .select({ amount: sql<string>`coalesce(sum(${refunds.refundedAmount}), 0)::text` })
      .from(refunds)
      .innerJoin(orders, eq(orders.id, refunds.orderId))
      .where(
        and(
          eq(refunds.status, 'succeeded'),
          isNull(refunds.deletedAt),
          isNull(orders.deletedAt),
          gte(refunds.succeededAt, args.from),
          lt(refunds.succeededAt, args.to),
        ),
      ),
  ]);
  const row = rows[0];
  return {
    orderCount: Number(row?.orderCount ?? 0),
    paidOrderCount: Number(row?.paidOrderCount ?? 0),
    paidAmount: row?.paidAmount ?? '0',
    refundedAmount: refunded[0]?.amount ?? '0',
  };
}

export interface WorkQueueCounts {
  pendingShipment: number;
  pendingReceipt: number;
  refunding: number;
  pendingInvoice: number;
}

/** The four live work-queue counters above the table. Whole shop, no date range. */
export async function workQueueCounts(db: DbOrTx): Promise<WorkQueueCounts> {
  const [orderSide, invoiceSide] = await Promise.all([
    db
      .select({
        pendingShipment: sql<number>`count(*) filter (where ${orders.status} = 'paid')::int`,
        pendingReceipt: sql<number>`count(*) filter (where ${orders.status} = 'shipped')::int`,
        refunding: sql<number>`count(*) filter (where ${hasOpenRefund()})::int`,
      })
      .from(orders)
      .where(isNull(orders.deletedAt)),
    // An operator's deleted order is out of every figure, its 待开票 included.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(orderInvoices)
      .innerJoin(orders, eq(orders.id, orderInvoices.orderId))
      .where(and(eq(orderInvoices.status, 'requested'), isNull(orders.deletedAt))),
  ]);
  return {
    pendingShipment: Number(orderSide[0]?.pendingShipment ?? 0),
    pendingReceipt: Number(orderSide[0]?.pendingReceipt ?? 0),
    refunding: Number(orderSide[0]?.refunding ?? 0),
    pendingInvoice: Number(invoiceSide[0]?.n ?? 0),
  };
}

// ---------------------------------------------------------------------------
// console writes
// ---------------------------------------------------------------------------

export async function setAdminRemark(
  tx: Tx,
  args: { orderId: number; remark: string },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, orders, {
    where: and(eq(orders.id, args.orderId), isNull(orders.deletedAt)),
    set: { adminRemark: args.remark, updatedAt: sql`now()` },
  });
}

/**
 * 改价. `status = 'pending_payment'` is in the WHERE, so a payment that landed
 * while the form was open makes this affect zero rows rather than rewriting the
 * price of an order somebody already paid.
 */
export async function applyRepricing(
  tx: Tx,
  args: {
    orderId: number;
    freightAmount: string;
    couponDiscount: string;
    operatorDiscount: string;
    payableAmount: string;
  },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, orders, {
    where: and(eq(orders.id, args.orderId), eq(orders.status, 'pending_payment')),
    set: {
      freightAmount: args.freightAmount,
      couponDiscount: args.couponDiscount,
      operatorDiscount: args.operatorDiscount,
      payableAmount: args.payableAmount,
      updatedAt: sql`now()`,
    },
  });
}

export async function setItemDiscount(
  tx: Tx,
  args: { orderItemId: number; discountAmount: string; totalAmount: string },
): Promise<void> {
  await tx
    .update(orderItems)
    .set({
      discountAmount: args.discountAmount,
      totalAmount: args.totalAmount,
      updatedAt: sql`now()`,
    })
    .where(eq(orderItems.id, args.orderItemId));
}

/** The receiver snapshot only. `user_addresses` belongs to the user domain and is never written from here. */
export async function updateReceiver(
  tx: Tx,
  args: { orderId: number; set: Record<string, unknown> },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, orders, {
    where: and(
      eq(orders.id, args.orderId),
      inArray(orders.status, ['pending_payment', 'paid']),
      eq(orders.fulfillmentStatus, 'unfulfilled'),
    ),
    set: { ...args.set, updatedAt: sql`now()` },
  });
}

/** Only a finished order with no after-sales still open can be filed away, and only once. */
export async function softDeleteOrder(
  tx: Tx,
  args: { orderId: number; at: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, orders, {
    where: and(
      eq(orders.id, args.orderId),
      inArray(orders.status, ['cancelled', 'completed', 'refunded']),
      isNull(orders.deletedAt),
      sql`not ${hasOpenRefund()}`,
    ),
    set: { deletedAt: args.at, updatedAt: sql`now()` },
  });
}

/** Stamps the auto-receive deadline when an order is fully shipped. */
export async function setAutoReceiveAt(
  tx: Tx,
  args: { orderId: number; at: Date | null },
): Promise<void> {
  await tx
    .update(orders)
    .set({ autoReceiveAt: args.at, updatedAt: sql`now()` })
    .where(eq(orders.id, args.orderId));
}

/**
 * Orders past their auto-receive deadline. Reads the partial index
 * `orders_auto_receive_idx (auto_receive_at) WHERE status = 'shipped'`.
 */
export async function listAutoReceiveDue(
  db: DbOrTx,
  args: { now: Date; limit: number },
): Promise<number[]> {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, 'shipped'),
        isNotNull(orders.autoReceiveAt),
        lte(orders.autoReceiveAt, args.now),
      ),
    )
    .orderBy(asc(orders.autoReceiveAt))
    .limit(args.limit);
  return rows.map((row) => row.id);
}

/** `received` orders whose review window has run out and which should now complete. */
export async function listCompletionDue(
  db: DbOrTx,
  args: { receivedBefore: Date; limit: number },
): Promise<number[]> {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, 'received'), lte(orders.receivedAt, args.receivedBefore)))
    .orderBy(asc(orders.receivedAt))
    .limit(args.limit);
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// invoices
// ---------------------------------------------------------------------------

export async function findInvoice(db: DbOrTx, id: number): Promise<OrderInvoiceRow | null> {
  const rows = await db.select().from(orderInvoices).where(eq(orderInvoices.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function insertInvoice(
  tx: Tx,
  values: NewOrderInvoiceValues,
): Promise<OrderInvoiceRow> {
  const rows = await tx.insert(orderInvoices).values(values).returning();
  return rows[0]!;
}

/**
 * The one live request per order is `order_invoices_open_uq`, a partial unique
 * index. `insertInvoice` learns "already asked" from the violation rather than
 * from a prior SELECT, which is the same argument as checkout's idempotency
 * key.
 */
const OPEN_INVOICE_CONSTRAINT = 'order_invoices_open_uq';

export function isOpenInvoiceConflict(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505' && candidate.constraint === OPEN_INVOICE_CONSTRAINT) return true;
    current = candidate.cause;
  }
  return false;
}

export async function transitionInvoice(
  tx: Tx,
  args: {
    invoiceId: number;
    from: readonly OrderInvoiceRow['status'][];
    to: OrderInvoiceRow['status'];
    set?: Record<string, unknown>;
  },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, orderInvoices, {
    where: and(eq(orderInvoices.id, args.invoiceId), inArray(orderInvoices.status, [...args.from])),
    set: { ...(args.set ?? {}), status: args.to, updatedAt: sql`now()` },
  });
}

export interface InvoiceFilter {
  userId?: number | undefined;
  status?: readonly OrderInvoiceRow['status'][] | undefined;
  headerType?: 'personal' | 'company' | undefined;
  invoiceType?: 'plain' | 'special' | undefined;
  keyword?: string | undefined;
  createdFrom?: Date | undefined;
  createdTo?: Date | undefined;
}

export async function listInvoices(
  db: DbOrTx,
  args: {
    filter: InvoiceFilter;
    sortBy?: 'id' | 'createdAt' | 'amount' | undefined;
    sortOrder?: 'asc' | 'desc' | undefined;
    offset: number;
    limit: number;
  },
): Promise<{ rows: InvoiceWithOrder[]; total: number }> {
  const keyword = args.filter.keyword?.trim();
  const where = allOf(
    args.filter.userId === undefined ? undefined : eq(orderInvoices.userId, args.filter.userId),
    args.filter.status?.length ? inArray(orderInvoices.status, [...args.filter.status]) : undefined,
    args.filter.headerType ? eq(orderInvoices.headerType, args.filter.headerType) : undefined,
    args.filter.invoiceType ? eq(orderInvoices.invoiceType, args.filter.invoiceType) : undefined,
    args.filter.createdFrom ? gte(orderInvoices.createdAt, args.filter.createdFrom) : undefined,
    args.filter.createdTo ? lte(orderInvoices.createdAt, args.filter.createdTo) : undefined,
    keyword
      ? or(
          sql`${orderInvoices.name} ilike ${containsPattern(keyword)}`,
          sql`${orderInvoices.dutyNumber} like ${containsPattern(keyword)}`,
          sql`${orders.orderNo} like ${containsPattern(keyword)}`,
        )
      : undefined,
  );

  const column =
    args.sortBy === 'amount'
      ? orderInvoices.amount
      : args.sortBy === 'createdAt'
        ? orderInvoices.createdAt
        : orderInvoices.id;
  const direction = args.sortOrder === 'asc' ? asc : desc;

  const rows = await db
    .select({ invoice: orderInvoices, ...INVOICE_ORDER })
    .from(orderInvoices)
    .innerJoin(orders, eq(orders.id, orderInvoices.orderId))
    .where(where)
    .orderBy(direction(column), desc(orderInvoices.id))
    .limit(args.limit)
    .offset(args.offset);

  const counted = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(orderInvoices)
    .innerJoin(orders, eq(orders.id, orderInvoices.orderId))
    .where(where);

  return {
    rows: rows.map(withOrder),
    total: Number(counted[0]?.total ?? 0),
  };
}

/**
 * An invoice with its order's number and money, read in the same join: whether
 * the order has since been refunded in full is shown on the invoice (a 已开票
 * one then needs 冲红 in the tax system), and it is read, never copied, so it
 * cannot drift from the order.
 */
export type InvoiceWithOrder = OrderInvoiceRow & {
  orderNo: string;
  order: {
    status: string;
    refundStatus: string;
    paidAmount: string | null;
    refundedAmount: string;
  };
};

const INVOICE_ORDER = {
  orderNo: orders.orderNo,
  orderStatus: orders.status,
  refundStatus: orders.refundStatus,
  paidAmount: orders.paidAmount,
  refundedAmount: orders.refundedAmount,
};

function withOrder(row: {
  invoice: OrderInvoiceRow;
  orderNo: string;
  orderStatus: string;
  refundStatus: string;
  paidAmount: string | null;
  refundedAmount: string;
}): InvoiceWithOrder {
  return {
    ...row.invoice,
    orderNo: row.orderNo,
    order: {
      status: row.orderStatus,
      refundStatus: row.refundStatus,
      paidAmount: row.paidAmount,
      refundedAmount: row.refundedAmount,
    },
  };
}

export async function findInvoiceWithOrderNo(
  db: DbOrTx,
  id: number,
): Promise<InvoiceWithOrder | null> {
  const rows = await db
    .select({ invoice: orderInvoices, ...INVOICE_ORDER })
    .from(orderInvoices)
    .innerJoin(orders, eq(orders.id, orderInvoices.orderId))
    .where(eq(orderInvoices.id, id))
    .limit(1);
  const row = rows[0];
  return row ? withOrder(row) : null;
}
