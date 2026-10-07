import type { DbOrTx, Tx } from '@shop/db';
import { admins } from '@shop/db/schema/auth';
import { orderItems, orders, shipmentItems, shipments } from '@shop/db/schema/order';
import {
  refundItems,
  refundLogs,
  refunds,
  type RefundRequestContext,
} from '@shop/db/schema/refund';
import { expressCompanies } from '@shop/db/schema/reference';
import { users } from '@shop/db/schema/user';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { allOf, conditionalUpdate, type ConditionalUpdateResult } from '../kernel/tx';
import { IN_FLIGHT_STATUSES } from './refund.rules';

/**
 * The only file in the refund domain that touches Drizzle tables.
 *
 * Two rules from the schema shape almost every statement here:
 *
 *  - **`refund_items.is_open` mirrors the parent status**, and the partial
 *    unique index `refund_items(order_item_id) WHERE is_open` is what makes
 *    "one in-flight refund per order line" true without a lock. So every
 *    statement that moves a refund to a terminal status flips `is_open` in the
 *    same transaction step — `settleRefund` does both, and nothing else may
 *    write `status` on its own.
 *  - **`orders.refunded_amount <= orders.paid_amount`** is a CHECK, so the
 *    cumulative ceiling is enforced by PostgreSQL even if a caller forgets to
 *    ask. The service still asks, under `FOR UPDATE`, so the shopper gets
 *    `REFUND_EXCEEDS_PAID` instead of a 500 (REFUND-007).
 */

export type { RefundRequestContext };

export type RefundRow = typeof refunds.$inferSelect;
export type RefundItemRow = typeof refundItems.$inferSelect;
export type RefundLogRow = typeof refundLogs.$inferSelect;

/**
 * The statuses in which a refund is still in flight — `failed` included, since
 * the merchant can retry it (REFUND-017). See `IN_FLIGHT_STATUSES`.
 */
export const OPEN_REFUND_STATUSES = IN_FLIGHT_STATUSES;
export type OpenRefundStatus = (typeof OPEN_REFUND_STATUSES)[number];

/** PostgreSQL's unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

/**
 * Whether this is PostgreSQL refusing a duplicate, optionally on one index.
 *
 * Drizzle wraps every driver error in a `DrizzleQueryError` and puts the `pg`
 * error — the only object that carries `code` and `constraint` — on `cause`, so
 * the wrapper has to be unwrapped or `REFUND_ALREADY_OPEN` comes back to the
 * shopper as a 500. The loop walks the whole chain rather than one level,
 * because a pool error can be nested twice.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  for (let current = error, depth = 0; current !== null && depth < 5; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (candidate.code === UNIQUE_VIOLATION) {
      return constraint === undefined || candidate.constraint === constraint;
    }
    if (typeof candidate.cause !== 'object' || candidate.cause === null) return false;
    current = candidate.cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// the order side
// ---------------------------------------------------------------------------

export interface OrderRefundRow {
  id: number;
  orderNo: string;
  userId: number;
  status: string;
  refundStatus: string;
  paidAmount: string | null;
  refundedAmount: string;
  freightAmount: string;
  fulfillmentStatus: string;
  userCouponId: number | null;
  deletedAt: Date | null;
}

const orderColumns = {
  id: orders.id,
  orderNo: orders.orderNo,
  userId: orders.userId,
  status: orders.status,
  refundStatus: orders.refundStatus,
  paidAmount: orders.paidAmount,
  refundedAmount: orders.refundedAmount,
  freightAmount: orders.freightAmount,
  fulfillmentStatus: orders.fulfillmentStatus,
  userCouponId: orders.userCouponId,
  deletedAt: orders.deletedAt,
} as const;

export async function findOrder(db: DbOrTx, orderId: number): Promise<OrderRefundRow | null> {
  const rows = await db.select(orderColumns).from(orders).where(eq(orders.id, orderId)).limit(1);
  return (rows[0] as OrderRefundRow | undefined) ?? null;
}

/**
 * The order row, locked.
 *
 * Every money decision in this domain is made against this lock: the ceiling
 * check, the running total, and the order's own refund roll-up. Taking it first
 * and in one place is what stops two refunds on different lines of one order
 * from each seeing the other's "before" total.
 */
export async function lockOrder(tx: Tx, orderId: number): Promise<OrderRefundRow | null> {
  const rows = await tx
    .select(orderColumns)
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1)
    .for('update');
  return (rows[0] as OrderRefundRow | undefined) ?? null;
}

export interface OrderItemRow {
  id: number;
  orderId: number;
  /** The variant the stock port puts back when an unshipped line is refunded. */
  skuId: number;
  itemKey: string;
  quantity: number;
  unitPrice: string;
  totalAmount: string;
  refundedQuantity: number;
  refundedAmount: string;
  shippedQuantity: number;
  snapshot: { productName: string; productImageUrl: string; specText: string };
}

export async function listOrderItems(db: DbOrTx, orderId: number): Promise<OrderItemRow[]> {
  const rows = await db
    .select({
      id: orderItems.id,
      orderId: orderItems.orderId,
      skuId: orderItems.skuId,
      itemKey: orderItems.itemKey,
      quantity: orderItems.quantity,
      unitPrice: orderItems.unitPrice,
      totalAmount: orderItems.totalAmount,
      refundedQuantity: orderItems.refundedQuantity,
      refundedAmount: orderItems.refundedAmount,
      shippedQuantity: orderItems.shippedQuantity,
      snapshot: orderItems.snapshot,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id));
  return rows as OrderItemRow[];
}

/** Order item ids that are already inside an in-flight refund. */
export async function listOpenItemIds(db: DbOrTx, orderId: number): Promise<number[]> {
  const rows = await db
    .select({ orderItemId: refundItems.orderItemId })
    .from(refundItems)
    .innerJoin(refunds, eq(refunds.id, refundItems.refundId))
    .where(and(eq(refunds.orderId, orderId), eq(refundItems.isOpen, true)));
  return rows.map((r) => r.orderItemId);
}

/** The money already committed to open requests, which the ceiling must include. */
export async function openRefundTotal(db: DbOrTx, orderId: number): Promise<string> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${refunds.amount}), 0)::text` })
    .from(refunds)
    .where(
      and(
        eq(refunds.orderId, orderId),
        inArray(refunds.status, [...OPEN_REFUND_STATUSES]),
        isNull(refunds.deletedAt),
      ),
    );
  return row?.total ?? '0';
}

/**
 * Whether the order's freight is already in a refund that gave it back or
 * still may. Freight goes back once: a second full request after a first one
 * was carried with it must not carry it again.
 */
export async function freightClaimed(db: DbOrTx, orderId: number): Promise<boolean> {
  const rows = await db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.orderId, orderId),
        eq(refunds.includesFreight, true),
        inArray(refunds.status, [...OPEN_REFUND_STATUSES, 'succeeded']),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The order's units, and how many of them a settled refund covers — the
 * roll-up of an order that collected nothing is measured in units (REFUND-016).
 */
export async function orderUnits(
  db: DbOrTx,
  orderId: number,
): Promise<{ ordered: number; settled: number }> {
  const [ordered] = await db
    .select({ total: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int` })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  const [settled] = await db
    .select({ total: sql<number>`coalesce(sum(${refundItems.quantity}), 0)::int` })
    .from(refundItems)
    .innerJoin(refunds, eq(refunds.id, refundItems.refundId))
    .where(and(eq(refunds.orderId, orderId), eq(refunds.status, 'succeeded')));
  return { ordered: ordered?.total ?? 0, settled: settled?.total ?? 0 };
}

/**
 * Adds to the order's running refunded total, guarded by the ceiling.
 *
 * The `WHERE` carries the invariant, so two concurrent settlements cannot both
 * pass a check they each made beforehand: the second one simply updates zero
 * rows and the caller sees it (REFUND-007).
 */
export async function addOrderRefundedAmount(
  tx: DbOrTx,
  orderId: number,
  amount: string,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, orders, {
    where: and(
      eq(orders.id, orderId),
      sql`${orders.refundedAmount} + ${amount}::numeric <= coalesce(${orders.paidAmount}, 0)`,
    ),
    set: { refundedAmount: sql`${orders.refundedAmount} + ${amount}::numeric` },
  });
}

export async function setOrderRefundStatus(
  tx: DbOrTx,
  orderId: number,
  status: 'none' | 'requested' | 'partially_refunded' | 'refunded',
): Promise<void> {
  await tx.update(orders).set({ refundStatus: status }).where(eq(orders.id, orderId));
}

/**
 * `paid|shipped|received|completed → refunded`, for a full refund.
 *
 * The guard is `ORDER_TRANSITIONS` spelled as SQL. It is written here rather
 * than through `OrderStateMachine.transition` so the refund domain does not
 * depend on the order domain having registered its implementation, and so the
 * statement can be exercised by a concurrency test that boots nothing but this
 * domain.
 */
export async function markOrderRefunded(
  tx: DbOrTx,
  orderId: number,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, orders, {
    where: and(
      eq(orders.id, orderId),
      inArray(orders.status, ['paid', 'shipped', 'received', 'completed']),
    ),
    set: { status: 'refunded' },
  });
}

/**
 * The units of one order line that are spoken for.
 *
 * A subquery rather than a running `+ q`, because `refunded_quantity` has two
 * writers at two different moments and an increment cannot be replayed safely:
 *
 *  - a **`refund_only`** takes its units out of fulfilment the moment it is
 *    approved, and keeps them while it is in flight — `failed` included, since
 *    the merchant can still retry it. The warehouse must not ship goods an
 *    operator has already agreed to refund, and fulfilment's dispatch bound
 *    reads exactly this column (`shipped + q <= quantity - refunded_quantity`);
 *  - a **`return_and_refund`** counts only once the money is actually back —
 *    those units were shipped, and they are already out of fulfilment.
 *
 * Deriving the number instead of accumulating it makes every write idempotent
 * (settling a refund that was counted at approval changes nothing) and makes
 * release automatic: a `refund_only` that is withdrawn, rejected or closed
 * drops out of the set and the units come back to the warehouse with no
 * compensating update.
 *
 * `countsUnits` in `refund.rules.ts` is the same table in TypeScript.
 */
const countedUnits = (orderItemId: number) => sql<number>`(
  select coalesce(sum(${refundItems.quantity}), 0)::int
    from ${refundItems}
    join ${refunds} on ${refunds.id} = ${refundItems.refundId}
   where ${refundItems.orderItemId} = ${orderItemId}
     and (${refunds.status} = 'succeeded'
          or (${refunds.kind} = 'refund_only'
              and ${refunds.status} in ('approved', 'processing', 'unknown', 'failed')))
)`;

/**
 * Units of a line that left the warehouse *after* this refund was applied, in
 * shipments still standing.
 *
 * The request is dated by `refunds.created_at` and a dispatch by
 * `shipments.created_at`, both written with `clock_timestamp()` while the
 * writer holds the order row (`apply`, `shipOrder`, auto-delivery all lock it
 * first), so the two are in the order the lock let them through.
 */
const shippedSinceApplied = (refundId: number, orderItemId: number) => sql<number>`(
  select coalesce(sum(${shipmentItems.quantity}), 0)::int
    from ${shipmentItems}
    join ${shipments} on ${shipments.id} = ${shipmentItems.shipmentId}
   where ${shipmentItems.orderItemId} = ${orderItemId}
     and ${shipments.status} <> 'cancelled'
     and ${shipments.createdAt} > (select ${refunds.createdAt} from ${refunds} where ${refunds.id} = ${refundId})
)`;

/**
 * Re-derives `order_items.refunded_quantity` from the refunds themselves.
 *
 * `bound` is the mirror of fulfilment's dispatch guard (FULFILL-002,
 * `shipped + q <= quantity - refunded_quantity`):
 *
 *  - `approval` — a 仅退款 taking its units. What it may take is decided by
 *    what the line looked like **when the buyer applied**: units that had
 *    shipped by then are goods the buyer keeps (a money-only refund), units
 *    that had not are units the warehouse must now hold back. So the ceiling
 *    is `quantity - (units shipped since the request)`: a dispatch that went
 *    out between the request and the approval — the last units, or the other
 *    two of a line of three with one shipped earlier — makes the approval
 *    refuse instead of refunding goods that are on their way (REFUND-021).
 *    `transitionRefund` holds the order and its lines first, as shipping
 *    does, so a dispatch either committed before this statement and is
 *    counted, or waits and then meets the raised `refunded_quantity`.
 *  - `whole-line` — goods that came back, a settlement, a release: the ceiling
 *    is the line's whole quantity, and lowering a count never crosses it.
 *  - `retry` — a request that is sent again: it may keep what it already
 *    counts, and grow only into units that have not shipped. A failed 仅退款
 *    written before failed requests kept their units lost them at the failure,
 *    and the warehouse may have shipped them since; paying it again then would
 *    hand over goods and money (REFUND-015).
 */
export type UnitBound = 'approval' | 'whole-line' | 'retry';

export async function recomputeItemRefundedQuantity(
  tx: DbOrTx,
  refundId: number,
  orderItemId: number,
  bound: UnitBound,
): Promise<ConditionalUpdateResult> {
  const counted = countedUnits(orderItemId);
  const ceiling =
    bound === 'approval'
      ? sql`${orderItems.quantity} - ${shippedSinceApplied(refundId, orderItemId)}`
      : bound === 'retry'
        ? sql`greatest(${orderItems.quantity} - ${orderItems.shippedQuantity}, ${orderItems.refundedQuantity})`
        : sql`${orderItems.quantity}`;
  return conditionalUpdate(tx, orderItems, {
    where: and(eq(orderItems.id, orderItemId), sql`${counted} <= ${ceiling}`),
    set: { refundedQuantity: counted },
  });
}

/** The money side, raised only when the money is actually back. */
export async function addItemRefundedAmount(
  tx: DbOrTx,
  orderItemId: number,
  amount: string,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, orderItems, {
    where: eq(orderItems.id, orderItemId),
    set: {
      refundedAmount: sql`least(${orderItems.refundedAmount} + ${amount}::numeric, ${orderItems.totalAmount})`,
    },
  });
}

// ---------------------------------------------------------------------------
// refunds
// ---------------------------------------------------------------------------

export interface NewRefundInput {
  refundNo: string;
  outRefundNo: string;
  orderId: number;
  userId: number;
  paymentAttemptId: number | null;
  kind: 'refund_only' | 'return_and_refund';
  returnStage: 'not_required' | 'awaiting_shipment';
  quantity: number;
  amount: string;
  includesFreight: boolean;
  reason: string;
  explanation: string | null;
  images: string[];
  isAutomatic: boolean;
  /** The operator who opened it (商家发起售后); absent for a buyer's or an automatic one. */
  initiatedByAdminId?: number | null;
}

/**
 * `created_at` is the moment of the insert, not of the transaction's start:
 * the caller holds the order row, and `shippedSinceApplied` compares this
 * against a dispatch made under the same lock (REFUND-021).
 */
export async function insertRefund(tx: Tx, input: NewRefundInput): Promise<RefundRow> {
  const rows = await tx
    .insert(refunds)
    .values({ ...input, createdAt: sql`clock_timestamp()` })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('insertRefund: 插入未返回行');
  return row;
}

export interface NewRefundItemInput {
  refundId: number;
  orderItemId: number;
  quantity: number;
  amount: string;
}

/**
 * Inserts the lines. Throws the raw unique violation on
 * `refund_items_open_uq`, which the service turns into `REFUND_ALREADY_OPEN` —
 * the database decides the race, not a prior read.
 */
export async function insertRefundItems(tx: Tx, rows: NewRefundItemInput[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(refundItems).values(rows.map((r) => ({ ...r, isOpen: true })));
}

export async function findRefund(db: DbOrTx, id: number): Promise<RefundRow | null> {
  const rows = await db
    .select()
    .from(refunds)
    .where(and(eq(refunds.id, id), isNull(refunds.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findRefundByOutRefundNo(
  db: DbOrTx,
  outRefundNo: string,
): Promise<RefundRow | null> {
  const rows = await db.select().from(refunds).where(eq(refunds.outRefundNo, outRefundNo)).limit(1);
  return rows[0] ?? null;
}

export async function lockRefund(tx: Tx, id: number): Promise<RefundRow | null> {
  const rows = await tx.select().from(refunds).where(eq(refunds.id, id)).limit(1).for('update');
  return rows[0] ?? null;
}

export async function lockRefundByOutRefundNo(
  tx: Tx,
  outRefundNo: string,
): Promise<RefundRow | null> {
  const rows = await tx
    .select()
    .from(refunds)
    .where(eq(refunds.outRefundNo, outRefundNo))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

export async function listRefundItems(db: DbOrTx, refundId: number): Promise<RefundItemRow[]> {
  return db
    .select()
    .from(refundItems)
    .where(eq(refundItems.refundId, refundId))
    .orderBy(asc(refundItems.id));
}

export async function listItemsForRefunds(
  db: DbOrTx,
  refundIds: readonly number[],
): Promise<Map<number, Array<RefundItemRow & { snapshot: OrderItemRow['snapshot'] }>>> {
  const out = new Map<number, Array<RefundItemRow & { snapshot: OrderItemRow['snapshot'] }>>();
  if (refundIds.length === 0) return out;
  const rows = await db
    .select({ item: refundItems, snapshot: orderItems.snapshot })
    .from(refundItems)
    .innerJoin(orderItems, eq(orderItems.id, refundItems.orderItemId))
    .where(inArray(refundItems.refundId, [...refundIds]))
    .orderBy(asc(refundItems.id));
  for (const row of rows) {
    const list = out.get(row.item.refundId) ?? [];
    list.push({ ...row.item, snapshot: row.snapshot as OrderItemRow['snapshot'] });
    out.set(row.item.refundId, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// status moves
// ---------------------------------------------------------------------------

/** The `is_open` value each status implies. One table, so the two cannot drift. */
export function isOpenFor(status: RefundRow['status']): boolean {
  return (OPEN_REFUND_STATUSES as readonly string[]).includes(status);
}

export interface TransitionPatch {
  reviewedByAdminId?: number | null;
  reviewedAt?: Date;
  rejectReason?: string;
  adminRemark?: string;
  returnStage?: 'not_required' | 'awaiting_shipment' | 'shipped_back' | 'received';
  /** Frozen once, at the approval that first asks the buyer to ship. */
  returnAddress?: { name: string; phone: string; address: string };
  succeededAt?: Date;
  failedAt?: Date;
  cancelledAt?: Date;
  refundedAmount?: string;
  gatewayRefundId?: string | null;
  /** Raw, for 技术详情. Written and cleared together with `lastErrorSummary`. */
  lastError?: string | null;
  /** The same failure in Chinese, what staff read. */
  lastErrorSummary?: string | null;
  requestContext?: RefundRequestContext;
}

/**
 * How a transition re-derives its lines' `refunded_quantity` — see `UnitBound`.
 * `whole-line` (the default) is anything but taking units: a withdrawal, a
 * rejection, a settlement.
 */
export type TransitionUnits = UnitBound;

export interface TransitionResult extends ConditionalUpdateResult {
  /** Order lines whose units could not be taken. Empty unless the bound refused. */
  refusedLines: number[];
}

/**
 * The only way a refund changes status.
 *
 * One conditional `UPDATE` guarded by the statuses it may come from, and — in
 * the same transaction step — the `is_open` flip on its lines and the
 * re-derivation of their `refunded_quantity`. Doing all three here is what
 * keeps `refund_items_open_uq` and the units honest: a refund that leaves the
 * in-flight set always frees its lines and hands its units back, one that
 * stays always holds them, and no caller can move a status and forget the
 * units (REFUND-015 — a withdrawn approved 仅退款 once kept its units frozen).
 *
 * A caller that gets `refusedLines` back must refuse the whole move: throwing
 * rolls the status back with it.
 */
export async function transitionRefund(
  tx: Tx,
  id: number,
  from: readonly RefundRow['status'][],
  to: RefundRow['status'],
  patch: TransitionPatch = {},
  units: TransitionUnits = 'whole-line',
): Promise<TransitionResult> {
  const result = await conditionalUpdate(tx, refunds, {
    where: and(eq(refunds.id, id), inArray(refunds.status, [...from])),
    set: { status: to, ...patch },
  });
  if (!result.won) return { ...result, refusedLines: [] };

  await lockOrderLines(tx, id);

  const open = isOpenFor(to);
  await tx.update(refundItems).set({ isOpen: open }).where(eq(refundItems.refundId, id));

  const lines = await tx
    .select({ orderItemId: refundItems.orderItemId })
    .from(refundItems)
    .where(eq(refundItems.refundId, id))
    .orderBy(asc(refundItems.orderItemId));
  const refusedLines: number[] = [];
  for (const line of lines) {
    const derived = await recomputeItemRefundedQuantity(tx, id, line.orderItemId, units);
    if (!derived.won) refusedLines.push(line.orderItemId);
  }
  return { ...result, refusedLines };
}

/**
 * The order row, then every one of its lines in ascending id: the locks
 * `shipOrder` takes, in the order it takes them (`lockOrder`, then
 * `lockLineProgress`). A refund moving units and a dispatch of the same order
 * therefore run one after the other, never interleaved, and a transition never
 * holds a line while waiting for the order that a dispatch holds while waiting
 * for the line. The refund row is locked before this by every caller.
 */
async function lockOrderLines(tx: Tx, refundId: number): Promise<void> {
  const [row] = await tx
    .select({ orderId: refunds.orderId })
    .from(refunds)
    .where(eq(refunds.id, refundId))
    .limit(1);
  if (!row) return;
  await lockOrder(tx, row.orderId);
  await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(eq(orderItems.orderId, row.orderId))
    .orderBy(asc(orderItems.id))
    .for('update');
}

export async function setReturnShipment(
  tx: Tx,
  id: number,
  patch: {
    returnExpressCompanyId: number;
    returnTrackingNo: string;
    returnPhone: string | null;
  },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, refunds, {
    where: and(
      eq(refunds.id, id),
      eq(refunds.status, 'approved'),
      inArray(refunds.returnStage, ['awaiting_shipment', 'shipped_back']),
    ),
    set: { ...patch, returnStage: 'shipped_back' },
  });
}

/**
 * Writes `last_error` without moving the status: a gateway answer that does not
 * match the refund is shown to an operator on the row it concerns, and the row
 * stays where it was.
 */
export async function setLastError(
  tx: DbOrTx,
  id: number,
  problem: { raw: string; summary: string },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, refunds, {
    where: eq(refunds.id, id),
    set: { lastError: problem.raw.slice(0, 512), lastErrorSummary: problem.summary.slice(0, 512) },
  });
}

export async function setAdminRemark(
  tx: DbOrTx,
  id: number,
  adminRemark: string,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, refunds, {
    where: eq(refunds.id, id),
    set: { adminRemark },
  });
}

export async function hideRefund(
  tx: DbOrTx,
  id: number,
  userId: number,
  at: Date,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, refunds, {
    where: and(
      eq(refunds.id, id),
      eq(refunds.userId, userId),
      // Not `failed`: the merchant can still retry it (REFUND-017).
      inArray(refunds.status, ['rejected', 'succeeded', 'cancelled']),
    ),
    set: { deletedAt: at },
  });
}

export async function insertLog(
  tx: DbOrTx,
  input: {
    refundId: number;
    fromStatus: RefundRow['status'] | null;
    toStatus: RefundRow['status'];
    message: string;
    operatorAdminId?: number | null;
    operatorUserId?: number | null;
  },
): Promise<void> {
  await tx.insert(refundLogs).values({
    refundId: input.refundId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    message: input.message,
    operatorAdminId: input.operatorAdminId ?? null,
    operatorUserId: input.operatorUserId ?? null,
  });
}

export async function listLogs(db: DbOrTx, refundId: number): Promise<RefundLogRow[]> {
  return db
    .select()
    .from(refundLogs)
    .where(eq(refundLogs.refundId, refundId))
    .orderBy(asc(refundLogs.id));
}

// ---------------------------------------------------------------------------
// lists
// ---------------------------------------------------------------------------

export interface MyListFilter {
  userId: number;
  state: 'all' | 'open' | 'succeeded' | 'closed';
  offset: number;
  limit: number;
}

export interface RefundListRow extends RefundRow {
  orderNo: string;
  userNickname: string | null;
}

/** The admin row also names the operator who opened it, if one did. */
export interface AdminRefundListRow extends RefundListRow {
  initiatedByAdminName: string | null;
}

const STATE_STATUSES: Record<
  Exclude<MyListFilter['state'], 'all'>,
  readonly RefundRow['status'][]
> = {
  open: [...OPEN_REFUND_STATUSES],
  succeeded: ['succeeded'],
  closed: ['rejected', 'cancelled'],
};

export async function listMyRefunds(
  db: DbOrTx,
  filter: MyListFilter,
): Promise<{ rows: RefundListRow[]; total: number }> {
  const where = allOf(
    eq(refunds.userId, filter.userId),
    isNull(refunds.deletedAt),
    filter.state === 'all' ? undefined : inArray(refunds.status, [...STATE_STATUSES[filter.state]]),
  );

  const rows = await db
    .select({ refund: refunds, orderNo: orders.orderNo })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(where)
    .orderBy(desc(refunds.id))
    .offset(filter.offset)
    .limit(filter.limit);

  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(refunds)
    .where(where);

  return {
    rows: rows.map((r) => ({ ...r.refund, orderNo: r.orderNo, userNickname: null })),
    total: count?.total ?? 0,
  };
}

export interface AdminListFilter {
  status?: readonly string[];
  kind?: string;
  returnStage?: string;
  orderId?: number;
  userId?: number;
  keyword?: string;
  createdFrom?: Date;
  createdTo?: Date;
  sort: 'id' | 'createdAt' | 'amount';
  order: 'asc' | 'desc';
  offset: number;
  limit: number;
}

const adminRowColumns = {
  refund: refunds,
  orderNo: orders.orderNo,
  nickname: users.nickname,
  initiatorName: admins.name,
};

function toAdminRow(r: {
  refund: RefundRow;
  orderNo: string;
  nickname: string | null;
  initiatorName: string | null;
}): AdminRefundListRow {
  return {
    ...r.refund,
    orderNo: r.orderNo,
    userNickname: r.nickname,
    initiatedByAdminName: r.initiatorName,
  };
}

export async function listAdminRefunds(
  db: DbOrTx,
  filter: AdminListFilter,
): Promise<{ rows: AdminRefundListRow[]; total: number }> {
  const keyword = filter.keyword?.trim();
  const where = allOf(
    filter.status === undefined || filter.status.length === 0
      ? undefined
      : inArray(refunds.status, filter.status as never),
    filter.kind === undefined ? undefined : eq(refunds.kind, filter.kind as never),
    filter.returnStage === undefined
      ? undefined
      : eq(refunds.returnStage, filter.returnStage as never),
    filter.orderId === undefined ? undefined : eq(refunds.orderId, filter.orderId),
    filter.userId === undefined ? undefined : eq(refunds.userId, filter.userId),
    keyword
      ? or(
          eq(refunds.refundNo, keyword),
          eq(refunds.outRefundNo, keyword),
          eq(orders.orderNo, keyword),
        )
      : undefined,
    filter.createdFrom === undefined ? undefined : gte(refunds.createdAt, filter.createdFrom),
    filter.createdTo === undefined ? undefined : lte(refunds.createdAt, filter.createdTo),
  );

  const column = { id: refunds.id, createdAt: refunds.createdAt, amount: refunds.amount }[
    filter.sort
  ];

  const rows = await db
    .select(adminRowColumns)
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .leftJoin(users, eq(users.id, refunds.userId))
    .leftJoin(admins, eq(admins.id, refunds.initiatedByAdminId))
    .where(where)
    .orderBy(filter.order === 'asc' ? asc(column) : desc(column))
    .offset(filter.offset)
    .limit(filter.limit);

  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .where(where);

  return {
    rows: rows.map(toAdminRow),
    total: count?.total ?? 0,
  };
}

/** One row with the joined columns the admin list carries. */
export async function findAdminRefund(db: DbOrTx, id: number): Promise<AdminRefundListRow | null> {
  const rows = await db
    .select(adminRowColumns)
    .from(refunds)
    .innerJoin(orders, eq(orders.id, refunds.orderId))
    .leftJoin(users, eq(users.id, refunds.userId))
    .leftJoin(admins, eq(admins.id, refunds.initiatedByAdminId))
    .where(eq(refunds.id, id))
    .limit(1);
  const row = rows[0];
  return row ? toAdminRow(row) : null;
}

export async function findExpressCompany(
  db: DbOrTx,
  id: number,
): Promise<{ id: number; name: string } | null> {
  const rows = await db
    .select({ id: expressCompanies.id, name: expressCompanies.name })
    .from(expressCompanies)
    .where(eq(expressCompanies.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Refunds the sweep should push forward: approved-and-ready, or lost mid-flight. */
export async function listExecutableRefunds(
  db: DbOrTx,
  args: { olderThan: Date; limit: number },
): Promise<RefundRow[]> {
  return db
    .select()
    .from(refunds)
    .where(
      and(
        inArray(refunds.status, ['processing', 'unknown']),
        lte(refunds.updatedAt, args.olderThan),
      ),
    )
    .orderBy(asc(refunds.updatedAt))
    .limit(args.limit);
}
