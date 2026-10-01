import type { DbOrTx, Tx } from '@shop/db';
import { productDescriptions, products, productSkus } from '@shop/db/schema/catalog';
import { orderItems, orders } from '@shop/db/schema/order';
import {
  presaleActivities,
  presaleActivitySkus,
  presaleOrders,
  presaleStockLedger,
  type PresaleActivity,
  type PresaleOrder,
  type PresaleStockLedgerRow,
} from '@shop/db/schema/presale';
import { users } from '@shop/db/schema/user';
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { conditionalUpdate, type ConditionalUpdateResult } from '../kernel/tx';
import type { StockDeltas } from './presale.rules';
import { containsPattern } from '../kernel/like';

/**
 * Every statement the presale domain runs. Statements, not decisions: no
 * `DomainError`, no `ctx`, no policy. A repo function returns rows or the
 * number of rows a conditional update changed; every branch on that number
 * lives in the service or the order seam.
 *
 * Only this file and the tests import `@shop/db/schema/*` (the `boundaries`
 * ESLint rule enforces it). It *reads* `products`, `product_skus`, `orders`,
 * `order_items` and `users` for the display joins the admin and storefront
 * lists need, and *writes* nothing outside the four `presale_*` tables: the SKU
 * stock ledger is the catalog's `StockPort` and the order row belongs to the
 * order domain.
 *
 * The statements worth reading are `reserveActivityStock`, `releaseActivityStock`
 * and `claimStockLedger`. Each carries every precondition in its `WHERE` (or, in
 * the ledger's case, in a unique index), so `affected === 0` / `null` is the
 * only way a caller learns "somebody was faster, or this already happened".
 */

export type { PresaleActivity, PresaleOrder, PresaleStockLedgerRow };

export type ActivityStatus = 'draft' | 'active' | 'paused' | 'ended';
export type PaymentMode = 'full' | 'deposit';
export type OrderStage =
  'deposit_pending' | 'deposit_paid' | 'final_pending' | 'final_paid' | 'expired' | 'cancelled';

/** An order that still owes the shopper goods, so its activity may not be deleted. */
const LIVE_ORDER_STATUSES = ['pending_payment', 'paid', 'shipped', 'received'] as const;

// ---------------------------------------------------------------------------
// activities
// ---------------------------------------------------------------------------

export interface ActivityRow extends PresaleActivity {
  productName: string;
}

export interface ActivityListFilters {
  keyword?: string | undefined;
  statuses?: readonly ActivityStatus[] | undefined;
  productId?: number | undefined;
  /** A storefront list shows only what a shopper may see, at this instant. */
  visibleAt?: Date | undefined;
  /** Only these activities (a DIY block's manual pick). Additive: omitted means no id filter. */
  ids?: readonly number[] | undefined;
  sortBy?: string | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
  limit: number;
  offset: number;
}

const activitySort = {
  id: presaleActivities.id,
  sortOrder: presaleActivities.sortOrder,
  sales: presaleActivities.sales,
  startAt: presaleActivities.startAt,
  createdAt: presaleActivities.createdAt,
} as const;

function activityWhere(filters: ActivityListFilters): SQL | undefined {
  const parts: (SQL | undefined)[] = [isNull(presaleActivities.deletedAt)];
  if (filters.keyword) {
    parts.push(sql`${presaleActivities.title} ilike ${containsPattern(filters.keyword)}`);
  }
  if (filters.statuses && filters.statuses.length > 0) {
    parts.push(inArray(presaleActivities.status, [...filters.statuses]));
  }
  if (filters.productId !== undefined) {
    parts.push(eq(presaleActivities.productId, filters.productId));
  }
  if (filters.ids !== undefined) {
    parts.push(inArray(presaleActivities.id, [...filters.ids]));
  }
  if (filters.visibleAt) {
    parts.push(eq(presaleActivities.status, 'active'));
    parts.push(lte(presaleActivities.startAt, filters.visibleAt));
    parts.push(gt(presaleActivities.endAt, filters.visibleAt));
  }
  return and(...parts);
}

export async function listActivities(
  db: DbOrTx,
  filters: ActivityListFilters,
): Promise<{ rows: ActivityRow[]; total: number }> {
  const where = activityWhere(filters);
  const column =
    activitySort[filters.sortBy as keyof typeof activitySort] ?? activitySort.sortOrder;
  const direction = filters.sortOrder === 'asc' ? asc : desc;

  const rows = await db
    .select({ activity: presaleActivities, productName: products.name })
    .from(presaleActivities)
    .innerJoin(products, eq(products.id, presaleActivities.productId))
    .where(where)
    .orderBy(direction(column), desc(presaleActivities.id))
    .limit(filters.limit)
    .offset(filters.offset);

  const [totalRow] = await db.select({ value: count() }).from(presaleActivities).where(where);

  return {
    rows: rows.map((row) => ({ ...row.activity, productName: row.productName })),
    total: totalRow?.value ?? 0,
  };
}

export async function findActivity(db: DbOrTx, id: number): Promise<ActivityRow | null> {
  const [row] = await db
    .select({ activity: presaleActivities, productName: products.name })
    .from(presaleActivities)
    .innerJoin(products, eq(products.id, presaleActivities.productId))
    .where(and(eq(presaleActivities.id, id), isNull(presaleActivities.deletedAt)))
    .limit(1);
  return row ? { ...row.activity, productName: row.productName } : null;
}

/**
 * The bare activity row, soft-deleted or not.
 *
 * The order hooks use this and not `findActivity`: an operator may have ended
 * and deleted a campaign between a payment and its refund, and a shopper's
 * 发货承诺 must not silently become "ship today" because the campaign row is
 * hidden from the admin list.
 */
export async function findActivityRow(db: DbOrTx, id: number): Promise<PresaleActivity | null> {
  const [row] = await db
    .select()
    .from(presaleActivities)
    .where(eq(presaleActivities.id, id))
    .limit(1);
  return row ?? null;
}

export async function insertActivity(
  tx: Tx,
  values: typeof presaleActivities.$inferInsert,
): Promise<PresaleActivity> {
  const rows = await tx.insert(presaleActivities).values(values).returning();
  return rows[0]!;
}

export async function updateActivity(
  tx: Tx,
  id: number,
  values: Partial<typeof presaleActivities.$inferInsert>,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, presaleActivities, {
    where: and(eq(presaleActivities.id, id), isNull(presaleActivities.deletedAt)),
    set: values,
  });
}

/**
 * Status moves carry the status we believe we are leaving, so two operators
 * clicking 上架 and 结束 at the same moment cannot both win.
 */
export async function setActivityStatus(
  tx: Tx,
  args: { id: number; from: readonly ActivityStatus[]; to: ActivityStatus; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, presaleActivities, {
    where: and(
      eq(presaleActivities.id, args.id),
      isNull(presaleActivities.deletedAt),
      inArray(presaleActivities.status, [...args.from]),
    ),
    set: { status: args.to, updatedAt: args.now },
  });
}

export async function softDeleteActivity(
  tx: Tx,
  args: { id: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, presaleActivities, {
    where: and(eq(presaleActivities.id, args.id), isNull(presaleActivities.deletedAt)),
    set: { deletedAt: args.now, status: 'ended', updatedAt: args.now },
  });
}

// ---------------------------------------------------------------------------
// activity SKUs
// ---------------------------------------------------------------------------

export interface ActivitySkuRow {
  id: number;
  activityId: number;
  skuId: number;
  price: string;
  stock: number;
  sales: number;
  quota: number | null;
  isEnabled: boolean;
  specText: string;
  specValues: Record<string, string>;
  imageUrl: string | null;
  skuPrice: string;
  skuOriginalPrice: string | null;
}

const activitySkuSelection = {
  id: presaleActivitySkus.id,
  activityId: presaleActivitySkus.activityId,
  skuId: presaleActivitySkus.skuId,
  price: presaleActivitySkus.price,
  stock: presaleActivitySkus.stock,
  sales: presaleActivitySkus.sales,
  quota: presaleActivitySkus.quota,
  isEnabled: presaleActivitySkus.isEnabled,
  specText: productSkus.specText,
  specValues: productSkus.specValues,
  imageUrl: productSkus.imageUrl,
  skuPrice: productSkus.price,
  skuOriginalPrice: productSkus.originalPrice,
} as const;

export async function listActivitySkus(
  db: DbOrTx,
  activityIds: readonly number[],
): Promise<ActivitySkuRow[]> {
  if (activityIds.length === 0) return [];
  return db
    .select(activitySkuSelection)
    .from(presaleActivitySkus)
    .innerJoin(productSkus, eq(productSkus.id, presaleActivitySkus.skuId))
    .where(inArray(presaleActivitySkus.activityId, [...activityIds]))
    .orderBy(asc(presaleActivitySkus.id));
}

export async function findActivitySku(
  db: DbOrTx,
  args: { activityId: number; skuId: number },
): Promise<ActivitySkuRow | null> {
  const [row] = await db
    .select(activitySkuSelection)
    .from(presaleActivitySkus)
    .innerJoin(productSkus, eq(productSkus.id, presaleActivitySkus.skuId))
    .where(
      and(
        eq(presaleActivitySkus.activityId, args.activityId),
        eq(presaleActivitySkus.skuId, args.skuId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface ActivitySkuInput {
  skuId: number;
  price: string;
  stock: number;
  quota: number | null;
  isEnabled: boolean;
}

/**
 * The activity's status and stock and every SKU's stock, locked for the rest
 * of the edit's transaction: an order decrementing either waits, so what the
 * edit compares against is what it overwrites.
 */
export async function lockActivityStock(
  tx: Tx,
  id: number,
): Promise<{ status: string; stock: number; skus: Map<number, number> } | null> {
  const [activity] = await tx
    .select({ status: presaleActivities.status, stock: presaleActivities.stock })
    .from(presaleActivities)
    .where(and(eq(presaleActivities.id, id), isNull(presaleActivities.deletedAt)))
    .for('update');
  if (!activity) return null;
  const skus = await tx
    .select({ skuId: presaleActivitySkus.skuId, stock: presaleActivitySkus.stock })
    .from(presaleActivitySkus)
    .where(eq(presaleActivitySkus.activityId, id))
    .for('update');
  return { ...activity, skus: new Map(skus.map((row) => [row.skuId, row.stock])) };
}

/**
 * The activity SKUs an edit would delete that orders still point at: a stock-ledger row
 * (`presale_stock_ledger.activity_sku_id`, ON DELETE RESTRICT) or units already sold. The
 * service refuses the edit with a typed 409 instead of letting the delete hit the foreign key.
 */
export async function listRemovedSkusInUse(
  tx: Tx,
  args: { activityId: number; keep: readonly number[] },
): Promise<number[]> {
  const rows = await tx
    .select({ skuId: presaleActivitySkus.skuId })
    .from(presaleActivitySkus)
    .where(
      and(
        eq(presaleActivitySkus.activityId, args.activityId),
        args.keep.length > 0 ? notInArray(presaleActivitySkus.skuId, [...args.keep]) : undefined,
        or(
          gt(presaleActivitySkus.sales, 0),
          exists(
            tx
              .select({ one: sql`1` })
              .from(presaleStockLedger)
              .where(eq(presaleStockLedger.activitySkuId, presaleActivitySkus.id)),
          ),
        ),
      ),
    );
  return rows.map((row) => row.skuId);
}

/**
 * Upserts the rows the form names and deletes the rest.
 *
 * `sales` is never in the `set`: it is the server's running total and an edit
 * must not reset it — rewriting the row wholesale would send 已售 back to zero
 * every time somebody fixed a typo. `stock` is in the `set`, because the
 * operator is restating how many units this campaign may still sell.
 *
 * `depositAmount` is written as `null` always: full payment only, and
 * `presale_activity_skus_prices_non_negative` has no opinion, but the activity
 * level `presale_activities_deposit_shape` does — keeping the two consistent is
 * cheaper than explaining an inconsistency later.
 */
export async function replaceActivitySkus(
  tx: Tx,
  args: { activityId: number; skus: readonly ActivitySkuInput[] },
): Promise<void> {
  const keep = args.skus.map((sku) => sku.skuId);
  await tx
    .delete(presaleActivitySkus)
    .where(
      keep.length > 0
        ? and(
            eq(presaleActivitySkus.activityId, args.activityId),
            notInArray(presaleActivitySkus.skuId, keep),
          )
        : eq(presaleActivitySkus.activityId, args.activityId),
    );
  for (const sku of args.skus) {
    await tx
      .insert(presaleActivitySkus)
      .values({
        activityId: args.activityId,
        skuId: sku.skuId,
        price: sku.price,
        depositAmount: null,
        stock: sku.stock,
        quota: sku.quota,
        isEnabled: sku.isEnabled,
      })
      .onConflictDoUpdate({
        target: [presaleActivitySkus.activityId, presaleActivitySkus.skuId],
        set: { price: sku.price, stock: sku.stock, quota: sku.quota, isEnabled: sku.isEnabled },
      });
  }
}

/** The product's long HTML body, for the storefront activity page. */
export async function findProductDescription(
  db: DbOrTx,
  productId: number,
): Promise<string | null> {
  const [row] = await db
    .select({ html: productDescriptions.contentHtml })
    .from(productDescriptions)
    .where(eq(productDescriptions.productId, productId))
    .limit(1);
  return row?.html ?? null;
}

/** Are the SKUs really this product's? Guards against a hand-crafted form body. */
export async function skuIdsOfProduct(db: DbOrTx, productId: number): Promise<number[]> {
  const rows = await db
    .select({ id: productSkus.id })
    .from(productSkus)
    .where(eq(productSkus.productId, productId));
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// activity stock — the campaign's own counters (invariant STOCK-004)
// ---------------------------------------------------------------------------

/**
 * Takes `quantity` off the activity SKU row and then the activity row, each in
 * one statement carrying `stock >= quantity` and the quota in its `WHERE`.
 *
 * The quota is part of the same `UPDATE` — checking it with a separate `SELECT`
 * and then decrementing oversells under load — so the last unit can only be
 * taken once however many checkouts collide on it.
 *
 * `false` means one of the two changed nothing. The caller is inside the order
 * transaction and throws, which rolls the other one back — a half-applied
 * reservation cannot survive.
 */
export async function reserveActivityStock(
  tx: Tx,
  args: { activityId: number; skuId: number; quantity: number },
): Promise<boolean> {
  const sku = await conditionalUpdate(tx, presaleActivitySkus, {
    where: and(
      eq(presaleActivitySkus.activityId, args.activityId),
      eq(presaleActivitySkus.skuId, args.skuId),
      eq(presaleActivitySkus.isEnabled, true),
      sql`${presaleActivitySkus.stock} >= ${args.quantity}`,
      sql`(${presaleActivitySkus.quota} is null or ${presaleActivitySkus.sales} + ${args.quantity} <= ${presaleActivitySkus.quota})`,
    ),
    set: { stock: sql`${presaleActivitySkus.stock} - ${args.quantity}` },
  });
  if (!sku.won) return false;

  const activity = await conditionalUpdate(tx, presaleActivities, {
    where: and(
      eq(presaleActivities.id, args.activityId),
      sql`${presaleActivities.stock} >= ${args.quantity}`,
      sql`(${presaleActivities.totalQuota} is null or ${presaleActivities.sales} + ${args.quantity} <= ${presaleActivities.totalQuota})`,
    ),
    set: { stock: sql`${presaleActivities.stock} - ${args.quantity}` },
  });
  return activity.won;
}

/**
 * Puts the units back. `soldToo` also walks `sales` down — the refund path,
 * where the reservation had already been turned into a sale.
 */
export async function releaseActivityStock(
  tx: Tx,
  args: { activityId: number; skuId: number; quantity: number; soldToo: boolean },
): Promise<void> {
  await conditionalUpdate(tx, presaleActivitySkus, {
    where: and(
      eq(presaleActivitySkus.activityId, args.activityId),
      eq(presaleActivitySkus.skuId, args.skuId),
    ),
    set: {
      stock: sql`${presaleActivitySkus.stock} + ${args.quantity}`,
      ...(args.soldToo
        ? { sales: sql`greatest(0, ${presaleActivitySkus.sales} - ${args.quantity})` }
        : {}),
    },
  });
  await conditionalUpdate(tx, presaleActivities, {
    where: eq(presaleActivities.id, args.activityId),
    set: {
      stock: sql`${presaleActivities.stock} + ${args.quantity}`,
      ...(args.soldToo
        ? { sales: sql`greatest(0, ${presaleActivities.sales} - ${args.quantity})` }
        : {}),
    },
  });
}

/**
 * Turns a reservation into a sale: stock stays down, `sales` goes up.
 *
 * The quota is checked *here*, in the same statement that moves `sales`, and
 * not only at reservation — STOCK-004. `total_quota` is a lifetime ceiling on
 * units **sold**, and `sales` only moves on payment, so a check at checkout
 * compares against a number that has not moved yet: with `stock: 100` and
 * `total_quota: 1`, a hundred shoppers each read `sales = 0`, each reserve, and
 * each pay, and 预售销量 sails past the cap. The reservation-time check stays
 * as the cheap early refusal — it is what stops the hundredth shopper once the
 * first one has paid — but this is the one that decides.
 *
 * `false` means the campaign has sold its last unit to somebody else while this
 * shopper's money was in flight. The caller owes them a refund.
 */
export async function commitActivitySales(
  tx: Tx,
  args: { activityId: number; skuId: number; quantity: number },
): Promise<boolean> {
  const sku = await conditionalUpdate(tx, presaleActivitySkus, {
    where: and(
      eq(presaleActivitySkus.activityId, args.activityId),
      eq(presaleActivitySkus.skuId, args.skuId),
      sql`(${presaleActivitySkus.quota} is null or ${presaleActivitySkus.sales} + ${args.quantity} <= ${presaleActivitySkus.quota})`,
    ),
    set: { sales: sql`${presaleActivitySkus.sales} + ${args.quantity}` },
  });
  if (!sku.won) return false;

  const activity = await conditionalUpdate(tx, presaleActivities, {
    where: and(
      eq(presaleActivities.id, args.activityId),
      sql`(${presaleActivities.totalQuota} is null or ${presaleActivities.sales} + ${args.quantity} <= ${presaleActivities.totalQuota})`,
    ),
    set: { sales: sql`${presaleActivities.sales} + ${args.quantity}` },
  });
  if (activity.won) return true;

  // The SKU had room and the campaign did not. Both counters move together or
  // neither does, and this is inside the payment's own transaction, so undoing
  // the half that landed is a plain statement rather than a saga.
  await conditionalUpdate(tx, presaleActivitySkus, {
    where: and(
      eq(presaleActivitySkus.activityId, args.activityId),
      eq(presaleActivitySkus.skuId, args.skuId),
    ),
    set: { sales: sql`greatest(0, ${presaleActivitySkus.sales} - ${args.quantity})` },
  });
  return false;
}

// ---------------------------------------------------------------------------
// the stock ledger — the idempotency key for both directions
// ---------------------------------------------------------------------------

export interface LedgerInput extends StockDeltas {
  activityId: number;
  activitySkuId: number | null;
  skuId: number;
  orderId: number;
  quantity: number;
}

/**
 * Claims one direction of one order's stock movement.
 *
 * `presale_stock_ledger_order_reason_uq` is `UNIQUE (order_id, reason)`, so
 * `ON CONFLICT DO NOTHING` returning nothing *is* the "already done" answer.
 * This is the whole of QUEUE-008: the effect ledger retries, a cancel can race
 * a payment timeout, and a refund callback can arrive twice — and the counters
 * move exactly once.
 *
 * `null` means somebody (or an earlier attempt) already recorded this
 * direction. The caller must then do nothing at all, not "do it anyway".
 */
export async function claimStockLedger(
  tx: Tx,
  reason: 'reserve' | 'release',
  input: LedgerInput,
): Promise<PresaleStockLedgerRow | null> {
  const rows = await tx
    .insert(presaleStockLedger)
    .values({ ...input, reason })
    .onConflictDoNothing({ target: [presaleStockLedger.orderId, presaleStockLedger.reason] })
    .returning();
  return rows[0] ?? null;
}

/**
 * Stamps the sale onto the reservation row when the money arrives.
 *
 * Without this the ledger could never balance. A reservation records
 * `salesDelta: 0` — placing an order sells nothing — and payment moves `sales`
 * on both the campaign and the product without writing a row of its own,
 * because `presale_stock_ledger_reason` has exactly two values and the schema
 * is frozen. A refund's release then records `-quantity` against a `+` that was
 * never written, and REFUND-002's "every ledger that moved comes back" reads as
 * a deficit.
 *
 * So the reservation row is amended rather than a third row invented: after
 * payment it says what it now means — "took `n` off the shelf and sold them".
 * The caller runs this only when its conditional stage move won, so it happens
 * exactly once per order however often the payment callback is replayed.
 */
export async function markLedgerCommitted(
  tx: Tx,
  args: { orderId: number; quantity: number },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, presaleStockLedger, {
    where: and(
      eq(presaleStockLedger.orderId, args.orderId),
      eq(presaleStockLedger.reason, 'reserve'),
    ),
    set: { activitySalesDelta: args.quantity, productSalesDelta: args.quantity },
  });
}

export async function listStockLedger(
  db: DbOrTx,
  orderId: number,
): Promise<PresaleStockLedgerRow[]> {
  return db
    .select()
    .from(presaleStockLedger)
    .where(eq(presaleStockLedger.orderId, orderId))
    .orderBy(asc(presaleStockLedger.id));
}

// ---------------------------------------------------------------------------
// presale orders
// ---------------------------------------------------------------------------

export async function insertPresaleOrder(
  tx: Tx,
  values: typeof presaleOrders.$inferInsert,
): Promise<PresaleOrder> {
  const rows = await tx.insert(presaleOrders).values(values).returning();
  return rows[0]!;
}

/** Everything a notice about one presale order says. */
export interface OrderNoticeRow {
  orderId: number;
  orderNo: string;
  paidAmount: string | null;
  userId: number;
  stage: OrderStage;
  shipNotBeforeAt: Date | null;
  activityId: number;
  activityTitle: string;
}

export async function findOrderNotice(db: DbOrTx, orderId: number): Promise<OrderNoticeRow | null> {
  const [row] = await db
    .select({
      orderId: presaleOrders.orderId,
      orderNo: orders.orderNo,
      paidAmount: orders.paidAmount,
      userId: orders.userId,
      stage: presaleOrders.stage,
      shipNotBeforeAt: presaleOrders.shipNotBeforeAt,
      activityId: presaleActivities.id,
      activityTitle: presaleActivities.title,
    })
    .from(presaleOrders)
    .innerJoin(orders, eq(orders.id, presaleOrders.orderId))
    .innerJoin(presaleActivities, eq(presaleActivities.id, presaleOrders.activityId))
    .where(eq(presaleOrders.orderId, orderId))
    .limit(1);
  return row ?? null;
}

export async function findPresaleOrder(db: DbOrTx, orderId: number): Promise<PresaleOrder | null> {
  const [row] = await db
    .select()
    .from(presaleOrders)
    .where(eq(presaleOrders.orderId, orderId))
    .limit(1);
  return row ?? null;
}

/**
 * The stage machine, as a conditional update.
 *
 * `from` is a list because the caller knows which stages may legitimately lead
 * to the target, and `affected === 0` means somebody moved it first — a cancel
 * that lost to a payment, or a replayed callback.
 */
export async function setStage(
  tx: Tx,
  args: {
    orderId: number;
    from: readonly OrderStage[];
    to: OrderStage;
    now: Date;
    patch?: Partial<typeof presaleOrders.$inferInsert>;
  },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, presaleOrders, {
    where: and(
      eq(presaleOrders.orderId, args.orderId),
      inArray(presaleOrders.stage, [...args.from]),
    ),
    set: { stage: args.to, updatedAt: args.now, ...(args.patch ?? {}) },
  });
}

/** The delete guard: an order that still owes goods pins the activity. */
export async function countLiveOrders(db: DbOrTx, activityId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(presaleOrders)
    .innerJoin(orders, eq(orders.id, presaleOrders.orderId))
    .where(
      and(
        eq(presaleOrders.activityId, activityId),
        inArray(orders.status, [...LIVE_ORDER_STATUSES]),
      ),
    );
  return row?.value ?? 0;
}

export interface PresaleOrderRow extends PresaleOrder {
  orderNo: string;
  orderStatus: string;
  userId: number;
  nickname: string | null;
  quantity: number;
  payableAmount: string;
  activityTitle: string;
}

export interface PresaleOrderFilters {
  activityId?: number | undefined;
  stages?: readonly OrderStage[] | undefined;
  userId?: number | undefined;
  sortBy?: string | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
  limit: number;
  offset: number;
}

const orderSort = {
  orderId: presaleOrders.orderId,
  createdAt: presaleOrders.createdAt,
  shipNotBeforeAt: presaleOrders.shipNotBeforeAt,
} as const;

export async function listPresaleOrders(
  db: DbOrTx,
  filters: PresaleOrderFilters,
): Promise<{ rows: PresaleOrderRow[]; total: number }> {
  const parts: (SQL | undefined)[] = [];
  if (filters.activityId !== undefined) {
    parts.push(eq(presaleOrders.activityId, filters.activityId));
  }
  if (filters.stages && filters.stages.length > 0) {
    parts.push(inArray(presaleOrders.stage, [...filters.stages]));
  }
  if (filters.userId !== undefined) parts.push(eq(orders.userId, filters.userId));
  const where = parts.length > 0 ? and(...parts) : undefined;

  const column = orderSort[filters.sortBy as keyof typeof orderSort] ?? orderSort.orderId;
  const direction = filters.sortOrder === 'asc' ? asc : desc;

  const rows = await db
    .select({
      presale: presaleOrders,
      orderNo: orders.orderNo,
      orderStatus: orders.status,
      userId: orders.userId,
      nickname: users.nickname,
      quantity: orders.totalQuantity,
      payableAmount: orders.payableAmount,
      activityTitle: presaleActivities.title,
    })
    .from(presaleOrders)
    .innerJoin(orders, eq(orders.id, presaleOrders.orderId))
    .innerJoin(presaleActivities, eq(presaleActivities.id, presaleOrders.activityId))
    .leftJoin(users, eq(users.id, orders.userId))
    .where(where)
    .orderBy(direction(column))
    .limit(filters.limit)
    .offset(filters.offset);

  const [totalRow] = await db
    .select({ value: count() })
    .from(presaleOrders)
    .innerJoin(orders, eq(orders.id, presaleOrders.orderId))
    .where(where);

  return {
    rows: rows.map((row) => ({
      ...row.presale,
      orderNo: row.orderNo,
      orderStatus: row.orderStatus,
      userId: row.userId,
      nickname: row.nickname,
      quantity: row.quantity,
      payableAmount: row.payableAmount,
      activityTitle: row.activityTitle,
    })),
    total: totalRow?.value ?? 0,
  };
}

/** What the order actually carries — the hooks are handed only an id. */
export async function orderLines(
  db: DbOrTx,
  orderId: number,
): Promise<{ skuId: number; quantity: number }[]> {
  return db
    .select({ skuId: orderItems.skuId, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id));
}

// ---------------------------------------------------------------------------
// the window sweep
// ---------------------------------------------------------------------------

/**
 * Campaigns whose sale window has closed. Reads
 * `presale_activities_expiry_idx`, which is partial on `status = 'active'`
 * precisely so this query is an index scan of the few rows that matter
 * (SMOKE-011).
 */
export async function findClosableActivityIds(
  db: DbOrTx,
  args: { now: Date; limit: number },
): Promise<number[]> {
  const rows = await db
    .select({ id: presaleActivities.id })
    .from(presaleActivities)
    .where(
      and(
        eq(presaleActivities.status, 'active'),
        isNull(presaleActivities.deletedAt),
        lte(presaleActivities.endAt, args.now),
      ),
    )
    .orderBy(asc(presaleActivities.endAt))
    .limit(args.limit);
  return rows.map((row) => row.id);
}

/**
 * Campaigns that have just come into their window.
 *
 * There is no status transition to make — the schema has no `scheduled` state,
 * and the storefront list already filters on `start_at <= now < end_at`, so an
 * `active` campaign becomes visible on its own. What the open half of the sweep
 * does is *record the event exactly once*, which is what a notification or a
 * channel refresh hangs off. `UNIQUE (scope, scope_id, event_type)` on the
 * effects ledger is the exactly-once, so this query only has to be bounded:
 * hence the lookback rather than "every active campaign, forever".
 */
export async function findOpenedActivityIds(
  db: DbOrTx,
  args: { since: Date; now: Date; limit: number },
): Promise<number[]> {
  const rows = await db
    .select({ id: presaleActivities.id })
    .from(presaleActivities)
    .where(
      and(
        eq(presaleActivities.status, 'active'),
        isNull(presaleActivities.deletedAt),
        gte(presaleActivities.startAt, args.since),
        lte(presaleActivities.startAt, args.now),
        gt(presaleActivities.endAt, args.now),
      ),
    )
    .orderBy(asc(presaleActivities.startAt))
    .limit(args.limit);
  return rows.map((row) => row.id);
}

/** Closes one campaign. `status = 'active'` in the `WHERE` makes it idempotent. */
export async function closeActivity(
  tx: Tx,
  args: { id: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, presaleActivities, {
    where: and(
      eq(presaleActivities.id, args.id),
      eq(presaleActivities.status, 'active'),
      lte(presaleActivities.endAt, args.now),
    ),
    set: { status: 'ended', updatedAt: args.now },
  });
}
