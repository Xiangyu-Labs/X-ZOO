import type { DbOrTx, Tx } from '@shop/db';
import { orders } from '@shop/db/schema/order';
import {
  capitalFlows,
  paymentAttempts,
  paymentCallbacks,
  paymentExceptions,
  type PaymentContext,
} from '@shop/db/schema/payment';
import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { allOf, conditionalUpdate, type ConditionalUpdateResult } from '../kernel/tx';

/**
 * The only file in the payment domain that touches Drizzle tables
 * (`docs/conventions.md`, "Import boundaries").
 *
 * A repo function is a *statement*, not a decision: it returns rows or the
 * number of rows a conditional update changed. Every branch on that number
 * lives in `payment.service.ts`, which is what makes the race tests readable —
 * they call these directly and assert on `won`.
 *
 * Two statements here carry the weight of the whole domain:
 *
 *  - `insertCallback` relies on `payment_callbacks_notify_uq` and returns
 *    whether *this* call inserted the row. A replayed notification therefore
 *    costs one INSERT and does nothing else (PAY-007).
 *  - `openAttemptFor` / `insertAttempt` rely on `payment_attempts_open_uq`, so
 *    two simultaneous "pay" taps cannot produce two merchant order numbers.
 */

/**
 * The frozen adapter context, re-exported so the service can name it without
 * importing `@shop/db/schema/*` — only a `*.repo.ts` may do that, and the type
 * is part of what this repo's callers hand in.
 */
export type { PaymentContext };

export type AttemptRow = typeof paymentAttempts.$inferSelect;
export type ExceptionRow = typeof paymentExceptions.$inferSelect;
export type CallbackRow = typeof paymentCallbacks.$inferSelect;
export type CapitalFlowRow = typeof capitalFlows.$inferSelect;

/** The attempt states in which money may still arrive. Mirrors `payment_attempts_open_uq`. */
export const OPEN_ATTEMPT_STATUSES = ['creating', 'submitted', 'closing', 'unknown'] as const;
export type OpenAttemptStatus = (typeof OPEN_ATTEMPT_STATUSES)[number];

// ---------------------------------------------------------------------------
// attempts
// ---------------------------------------------------------------------------

export async function findAttempt(db: DbOrTx, id: number): Promise<AttemptRow | null> {
  const rows = await db.select().from(paymentAttempts).where(eq(paymentAttempts.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findAttemptByOutTradeNo(
  db: DbOrTx,
  outTradeNo: string,
): Promise<AttemptRow | null> {
  const rows = await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.outTradeNo, outTradeNo))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The open attempt for an order, locked.
 *
 * `FOR UPDATE` rather than a plain read: every caller is about to decide
 * whether money can still arrive, and that decision must not be made against a
 * row another transaction is in the middle of settling.
 */
export async function lockOpenAttempt(tx: Tx, orderId: number): Promise<AttemptRow | null> {
  const rows = await tx
    .select()
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.orderId, orderId),
        inArray(paymentAttempts.status, [...OPEN_ATTEMPT_STATUSES]),
      ),
    )
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

/** Locks one attempt by its merchant order number. The callback path's first move. */
export async function lockAttemptByOutTradeNo(
  tx: Tx,
  outTradeNo: string,
): Promise<AttemptRow | null> {
  const rows = await tx
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.outTradeNo, outTradeNo))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

export async function listAttemptsForOrder(db: DbOrTx, orderId: number): Promise<AttemptRow[]> {
  return db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.orderId, orderId))
    .orderBy(desc(paymentAttempts.id));
}

/** The paid attempt of an order, if there is one. */
export async function findPaidAttempt(db: DbOrTx, orderId: number): Promise<AttemptRow | null> {
  const rows = await db
    .select()
    .from(paymentAttempts)
    .where(and(eq(paymentAttempts.orderId, orderId), eq(paymentAttempts.status, 'paid')))
    .limit(1);
  return rows[0] ?? null;
}

export interface NewAttemptInput {
  orderId: number;
  outTradeNo: string;
  channel: 'wechat_mini' | 'wechat_oa' | 'wechat_h5';
  mchId: string;
  appId: string;
  amount: string;
  payerUserId: number | null;
  context: PaymentContext;
}

/**
 * `INSERT … ON CONFLICT DO NOTHING` against `payment_attempts_open_uq`.
 *
 * `null` means another transaction already holds the open attempt for this
 * order. The caller re-reads rather than failing: a second "pay" tap is
 * ordinary traffic, not an error (PAYC-003).
 */
export async function insertAttempt(tx: Tx, input: NewAttemptInput): Promise<AttemptRow | null> {
  const rows = await tx
    .insert(paymentAttempts)
    .values({
      orderId: input.orderId,
      outTradeNo: input.outTradeNo,
      channel: input.channel,
      mchId: input.mchId,
      appId: input.appId,
      amount: input.amount,
      payerUserId: input.payerUserId,
      context: input.context,
      status: 'creating',
    })
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}

/** `creating|unknown → submitted`, recording what the gateway handed back. */
export async function markAttemptSubmitted(
  tx: DbOrTx,
  id: number,
  patch: { prepayId: string | null; lastResult: string },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, paymentAttempts, {
    where: and(
      eq(paymentAttempts.id, id),
      inArray(paymentAttempts.status, ['creating', 'submitted', 'unknown']),
    ),
    set: { status: 'submitted', prepayId: patch.prepayId, lastResult: patch.lastResult },
  });
}

/**
 * Any open state → `paid`.
 *
 * `transactionId` and `paidAt` are set in the same statement because
 * `payment_attempts_paid_shape` refuses the row otherwise — the CHECK is what
 * makes "paid without a transaction id" unrepresentable rather than merely
 * discouraged.
 */
export async function markAttemptPaid(
  tx: DbOrTx,
  id: number,
  patch: { transactionId: string; paidAt: Date; lastResult: string },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, paymentAttempts, {
    where: and(
      eq(paymentAttempts.id, id),
      inArray(paymentAttempts.status, [...OPEN_ATTEMPT_STATUSES]),
    ),
    set: {
      status: 'paid',
      transactionId: patch.transactionId,
      paidAt: patch.paidAt,
      lastResult: patch.lastResult,
    },
  });
}

export async function markAttemptClosing(
  tx: DbOrTx,
  id: number,
  lastResult: string,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, paymentAttempts, {
    where: and(
      eq(paymentAttempts.id, id),
      inArray(paymentAttempts.status, ['creating', 'submitted', 'closing', 'unknown']),
    ),
    set: { status: 'closing', lastResult },
  });
}

/**
 * → `closed`, and only ever after the gateway confirmed it.
 *
 * `closedConfirmedAt` is not optional: `payment_attempts_closed_shape` rejects
 * a `closed` row without it, so an optimistic close cannot be written even by
 * mistake. This single rule is why an unknown is never "probably closed"
 * (QUEUE-003 / QUEUE-004).
 */
export async function markAttemptClosed(
  tx: DbOrTx,
  id: number,
  patch: { confirmedAt: Date; lastResult: string },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, paymentAttempts, {
    where: and(
      eq(paymentAttempts.id, id),
      inArray(paymentAttempts.status, [...OPEN_ATTEMPT_STATUSES]),
    ),
    set: { status: 'closed', closedConfirmedAt: patch.confirmedAt, lastResult: patch.lastResult },
  });
}

export async function markAttemptFailed(
  tx: DbOrTx,
  id: number,
  lastResult: string,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, paymentAttempts, {
    where: and(eq(paymentAttempts.id, id), eq(paymentAttempts.status, 'creating')),
    set: { status: 'failed', lastResult },
  });
}

/** → `unknown`: the gateway did not answer, so nothing may be concluded. */
export async function markAttemptUnknown(
  tx: DbOrTx,
  id: number,
  lastResult: string,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, paymentAttempts, {
    where: and(
      eq(paymentAttempts.id, id),
      inArray(paymentAttempts.status, ['creating', 'submitted', 'closing']),
    ),
    set: { status: 'unknown', lastResult },
  });
}

/** Attempts the reconciliation sweep should ask the gateway about. */
export async function listStaleAttempts(
  db: DbOrTx,
  args: { olderThan: Date; limit: number },
): Promise<AttemptRow[]> {
  return db
    .select()
    .from(paymentAttempts)
    .where(
      and(
        inArray(paymentAttempts.status, [...OPEN_ATTEMPT_STATUSES]),
        lt(paymentAttempts.updatedAt, args.olderThan),
      ),
    )
    .orderBy(asc(paymentAttempts.updatedAt))
    .limit(args.limit);
}

// ---------------------------------------------------------------------------
// callbacks
// ---------------------------------------------------------------------------

export interface NewCallbackInput {
  kind: 'transaction_success' | 'refund_success' | 'refund_abnormal' | 'refund_closed' | 'unknown';
  mchId: string;
  providerNotifyId: string;
  outTradeNo: string | null;
  transactionId: string | null;
  signatureVerified: boolean;
  payload: Record<string, unknown>;
}

/**
 * Records one notification, exactly once.
 *
 * Returns the row when *this* call inserted it and `null` when the unique index
 * caught a replay. The whole duplicate-callback defence is this return value:
 * the caller does the work only when it holds the new row, so a notification
 * delivered five times books money once (PAY-007).
 */
export async function insertCallback(tx: Tx, input: NewCallbackInput): Promise<CallbackRow | null> {
  const rows = await tx
    .insert(paymentCallbacks)
    .values({
      kind: input.kind,
      mchId: input.mchId,
      providerNotifyId: input.providerNotifyId,
      outTradeNo: input.outTradeNo,
      transactionId: input.transactionId,
      signatureVerified: input.signatureVerified,
      payload: input.payload,
    })
    .onConflictDoNothing({
      target: [paymentCallbacks.mchId, paymentCallbacks.providerNotifyId],
    })
    .returning();
  return rows[0] ?? null;
}

export async function markCallbackProcessed(
  tx: DbOrTx,
  id: number,
  patch: { at: Date; result: string },
): Promise<void> {
  await tx
    .update(paymentCallbacks)
    .set({ processedAt: patch.at, result: patch.result.slice(0, 255) })
    .where(eq(paymentCallbacks.id, id));
}

export async function findCallbackByNotifyId(
  db: DbOrTx,
  mchId: string,
  notifyId: string,
): Promise<CallbackRow | null> {
  const rows = await db
    .select()
    .from(paymentCallbacks)
    .where(and(eq(paymentCallbacks.mchId, mchId), eq(paymentCallbacks.providerNotifyId, notifyId)))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// exceptions
// ---------------------------------------------------------------------------

export interface NewExceptionInput {
  orderId: number | null;
  paymentAttemptId: number | null;
  mchId: string;
  transactionId: string;
  outTradeNo: string | null;
  reason: 'duplicate_payment' | 'cancelled_order_payment' | 'unmatched_payment' | 'amount_mismatch';
  paidAmount: string;
  context: PaymentContext;
}

/**
 * One exception per `(mch_id, transaction_id)`.
 *
 * `null` means the row already existed — a replayed abnormal notification, or a
 * reconciliation pass finding what a callback already recorded. The caller
 * treats that as success: the money is on somebody's list either way.
 */
export async function insertException(
  tx: Tx,
  input: NewExceptionInput,
): Promise<ExceptionRow | null> {
  const rows = await tx
    .insert(paymentExceptions)
    .values({ ...input, status: 'open' })
    .onConflictDoNothing({
      target: [paymentExceptions.mchId, paymentExceptions.transactionId],
    })
    .returning();
  return rows[0] ?? null;
}

/** Exceptions whose money a person still has to send back or let go: 「异常待处理」. */
export async function countActionableExceptions(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentExceptions)
    .where(inArray(paymentExceptions.status, ['open', 'refund_failed', 'refund_unknown']));
  return row?.n ?? 0;
}

export async function findException(db: DbOrTx, id: number): Promise<ExceptionRow | null> {
  const rows = await db
    .select()
    .from(paymentExceptions)
    .where(eq(paymentExceptions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findExceptionByTransaction(
  db: DbOrTx,
  mchId: string,
  transactionId: string,
): Promise<ExceptionRow | null> {
  const rows = await db
    .select()
    .from(paymentExceptions)
    .where(
      and(eq(paymentExceptions.mchId, mchId), eq(paymentExceptions.transactionId, transactionId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function lockException(tx: Tx, id: number): Promise<ExceptionRow | null> {
  const rows = await tx
    .select()
    .from(paymentExceptions)
    .where(eq(paymentExceptions.id, id))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

/**
 * The exception behind a merchant refund number, locked.
 *
 * A refund notification carries only `out_refund_no`, and an exception refund's
 * number is minted here (prefix `X`) rather than on a `refunds` row. So the
 * refund webhook looks here when no `refunds` row matches — otherwise an
 * exception refund would only ever be settled by the sweep.
 */
export async function lockExceptionByRefundNo(
  tx: Tx,
  refundNo: string,
): Promise<ExceptionRow | null> {
  const rows = await tx
    .select()
    .from(paymentExceptions)
    .where(eq(paymentExceptions.refundNo, refundNo))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

/**
 * `open → refunding`, claiming the row and freezing its refund number.
 *
 * The number is generated once and written here; every later retry reuses it,
 * which is what makes an unknown refund queryable instead of re-sendable
 * (REFUND-005).
 */
export async function claimExceptionForRefund(
  tx: DbOrTx,
  id: number,
  patch: { refundNo: string; operatorAdminId: number | null; note: string | null },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, paymentExceptions, {
    where: and(
      eq(paymentExceptions.id, id),
      inArray(paymentExceptions.status, ['open', 'refund_failed']),
    ),
    set: {
      status: 'refunding',
      // COALESCE: a retry must not mint a second refund number for money that
      // may already be on its way back.
      refundNo: sql`coalesce(${paymentExceptions.refundNo}, ${patch.refundNo})`,
      operatorAdminId: patch.operatorAdminId,
      ...(patch.note === null ? {} : { note: patch.note }),
    },
  });
}

export async function settleException(
  tx: DbOrTx,
  id: number,
  patch: {
    status: 'refunded' | 'refund_failed' | 'refund_unknown';
    at: Date;
    refundRequest?: Record<string, unknown>;
    note?: string;
  },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, paymentExceptions, {
    // `refund_unknown` too: WeChat's usual first answer is PROCESSING, and the
    // real one (a callback, a recheck, a retried submit) must still land.
    where: and(
      eq(paymentExceptions.id, id),
      inArray(paymentExceptions.status, ['refunding', 'refund_unknown']),
    ),
    set: {
      status: patch.status,
      ...(patch.status === 'refunded' ? { refundedAt: patch.at, resolvedAt: patch.at } : {}),
      ...(patch.refundRequest === undefined ? {} : { refundRequest: patch.refundRequest }),
      ...(patch.note === undefined ? {} : { note: patch.note }),
    },
  });
}

export async function ignoreException(
  tx: DbOrTx,
  id: number,
  patch: { at: Date; operatorAdminId: number | null; note: string },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, paymentExceptions, {
    where: and(
      eq(paymentExceptions.id, id),
      inArray(paymentExceptions.status, ['open', 'refund_failed']),
    ),
    set: {
      status: 'ignored',
      resolvedAt: patch.at,
      operatorAdminId: patch.operatorAdminId,
      note: patch.note,
    },
  });
}

export async function touchExceptionAlarm(db: DbOrTx, id: number, at: Date): Promise<void> {
  await db.update(paymentExceptions).set({ alarmedAt: at }).where(eq(paymentExceptions.id, id));
}

/** Exceptions whose refund the reconciliation sweep should ask about again. */
export async function listUnsettledExceptions(
  db: DbOrTx,
  args: { olderThan: Date; limit: number },
): Promise<ExceptionRow[]> {
  return db
    .select()
    .from(paymentExceptions)
    .where(
      and(
        inArray(paymentExceptions.status, ['refunding', 'refund_unknown']),
        lt(paymentExceptions.updatedAt, args.olderThan),
      ),
    )
    .orderBy(asc(paymentExceptions.updatedAt))
    .limit(args.limit);
}

// ---------------------------------------------------------------------------
// capital flows
// ---------------------------------------------------------------------------

export interface NewCapitalFlowInput {
  kind: 'order_payment' | 'order_refund' | 'exception_refund';
  reference: string;
  direction: 'in' | 'out';
  amount: string;
  orderId: number | null;
  userId: number | null;
  mchId: string | null;
  transactionId: string | null;
  note: string | null;
  occurredAt: Date;
}

/**
 * The ledger write. `UNIQUE (kind, reference)` makes it exactly-once, so this
 * is safe to call from a retried effect handler (PAY-007).
 */
export async function insertCapitalFlow(
  tx: Tx,
  input: NewCapitalFlowInput,
): Promise<CapitalFlowRow | null> {
  const rows = await tx
    .insert(capitalFlows)
    .values({ ...input, note: input.note?.slice(0, 255) ?? null })
    .onConflictDoNothing({ target: [capitalFlows.kind, capitalFlows.reference] })
    .returning();
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// admin lists
// ---------------------------------------------------------------------------

export interface AttemptListFilter {
  orderId?: number;
  outTradeNo?: string;
  transactionId?: string;
  status?: readonly string[];
  channel?: string;
  createdFrom?: Date;
  createdTo?: Date;
  sort: 'id' | 'createdAt' | 'amount';
  order: 'asc' | 'desc';
  offset: number;
  limit: number;
}

export interface AttemptListRow extends AttemptRow {
  orderNo: string | null;
}

export async function listAttempts(
  db: DbOrTx,
  filter: AttemptListFilter,
): Promise<{ rows: AttemptListRow[]; total: number }> {
  const where = allOf(
    filter.orderId === undefined ? undefined : eq(paymentAttempts.orderId, filter.orderId),
    filter.outTradeNo === undefined ? undefined : eq(paymentAttempts.outTradeNo, filter.outTradeNo),
    filter.transactionId === undefined
      ? undefined
      : eq(paymentAttempts.transactionId, filter.transactionId),
    filter.status === undefined || filter.status.length === 0
      ? undefined
      : inArray(paymentAttempts.status, filter.status as never),
    filter.channel === undefined ? undefined : eq(paymentAttempts.channel, filter.channel as never),
    filter.createdFrom === undefined
      ? undefined
      : gte(paymentAttempts.createdAt, filter.createdFrom),
    filter.createdTo === undefined ? undefined : lte(paymentAttempts.createdAt, filter.createdTo),
  );

  const column = {
    id: paymentAttempts.id,
    createdAt: paymentAttempts.createdAt,
    amount: paymentAttempts.amount,
  }[filter.sort];

  const rows = await db
    .select({ attempt: paymentAttempts, orderNo: orders.orderNo })
    .from(paymentAttempts)
    .leftJoin(orders, eq(orders.id, paymentAttempts.orderId))
    .where(where)
    .orderBy(filter.order === 'asc' ? asc(column) : desc(column))
    .offset(filter.offset)
    .limit(filter.limit);

  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(paymentAttempts)
    .where(where);

  return {
    rows: rows.map((r) => ({ ...r.attempt, orderNo: r.orderNo })),
    total: count?.total ?? 0,
  };
}

export interface ExceptionListFilter {
  status?: readonly string[];
  reason?: string;
  keyword?: string;
  createdFrom?: Date;
  createdTo?: Date;
  sort: 'id' | 'createdAt' | 'paidAmount';
  order: 'asc' | 'desc';
  offset: number;
  limit: number;
}

export interface ExceptionListRow extends ExceptionRow {
  orderNo: string | null;
}

export async function listExceptions(
  db: DbOrTx,
  filter: ExceptionListFilter,
): Promise<{ rows: ExceptionListRow[]; total: number }> {
  const keyword = filter.keyword?.trim();
  const where = allOf(
    filter.status === undefined || filter.status.length === 0
      ? undefined
      : inArray(paymentExceptions.status, filter.status as never),
    filter.reason === undefined ? undefined : eq(paymentExceptions.reason, filter.reason as never),
    keyword
      ? or(
          eq(paymentExceptions.transactionId, keyword),
          eq(paymentExceptions.outTradeNo, keyword),
          eq(paymentExceptions.refundNo, keyword),
          eq(orders.orderNo, keyword),
        )
      : undefined,
    filter.createdFrom === undefined
      ? undefined
      : gte(paymentExceptions.createdAt, filter.createdFrom),
    filter.createdTo === undefined ? undefined : lte(paymentExceptions.createdAt, filter.createdTo),
  );

  const column = {
    id: paymentExceptions.id,
    createdAt: paymentExceptions.createdAt,
    paidAmount: paymentExceptions.paidAmount,
  }[filter.sort];

  const rows = await db
    .select({ exception: paymentExceptions, orderNo: orders.orderNo })
    .from(paymentExceptions)
    .leftJoin(orders, eq(orders.id, paymentExceptions.orderId))
    .where(where)
    .orderBy(filter.order === 'asc' ? asc(column) : desc(column))
    .offset(filter.offset)
    .limit(filter.limit);

  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(paymentExceptions)
    .leftJoin(orders, eq(orders.id, paymentExceptions.orderId))
    .where(where);

  return {
    rows: rows.map((r) => ({ ...r.exception, orderNo: r.orderNo })),
    total: count?.total ?? 0,
  };
}

export interface FlowListFilter {
  kind?: readonly string[];
  direction?: 'in' | 'out';
  orderId?: number;
  userId?: number;
  keyword?: string;
  occurredFrom?: Date;
  occurredTo?: Date;
  sort: 'id' | 'occurredAt' | 'amount';
  order: 'asc' | 'desc';
  offset: number;
  limit: number;
}

export interface FlowListRow extends CapitalFlowRow {
  orderNo: string | null;
}

function flowWhere(filter: FlowListFilter): SQL | undefined {
  const keyword = filter.keyword?.trim();
  return allOf(
    filter.kind === undefined || filter.kind.length === 0
      ? undefined
      : inArray(capitalFlows.kind, filter.kind as never),
    filter.direction === undefined ? undefined : eq(capitalFlows.direction, filter.direction),
    filter.orderId === undefined ? undefined : eq(capitalFlows.orderId, filter.orderId),
    filter.userId === undefined ? undefined : eq(capitalFlows.userId, filter.userId),
    keyword
      ? or(eq(capitalFlows.reference, keyword), eq(capitalFlows.transactionId, keyword))
      : undefined,
    filter.occurredFrom === undefined
      ? undefined
      : gte(capitalFlows.occurredAt, filter.occurredFrom),
    filter.occurredTo === undefined ? undefined : lte(capitalFlows.occurredAt, filter.occurredTo),
  );
}

export async function listCapitalFlows(
  db: DbOrTx,
  filter: FlowListFilter,
): Promise<{ rows: FlowListRow[]; total: number }> {
  const where = flowWhere(filter);
  const column = {
    id: capitalFlows.id,
    occurredAt: capitalFlows.occurredAt,
    amount: capitalFlows.amount,
  }[filter.sort];

  const rows = await db
    .select({ flow: capitalFlows, orderNo: orders.orderNo })
    .from(capitalFlows)
    .leftJoin(orders, eq(orders.id, capitalFlows.orderId))
    .where(where)
    .orderBy(filter.order === 'asc' ? asc(column) : desc(column))
    .offset(filter.offset)
    .limit(filter.limit);

  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(capitalFlows)
    .where(where);

  return { rows: rows.map((r) => ({ ...r.flow, orderNo: r.orderNo })), total: count?.total ?? 0 };
}

/**
 * The three numbers above the finance table, computed by PostgreSQL over the
 * same filter rather than by summing a page in JavaScript.
 */
export async function summariseCapitalFlows(
  db: DbOrTx,
  filter: FlowListFilter,
): Promise<{ inAmount: string; outAmount: string; count: number }> {
  const [row] = await db
    .select({
      inAmount: sql<string>`coalesce(sum(${capitalFlows.amount}) filter (where ${capitalFlows.direction} = 'in'), 0)::text`,
      outAmount: sql<string>`coalesce(sum(${capitalFlows.amount}) filter (where ${capitalFlows.direction} = 'out'), 0)::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(capitalFlows)
    .where(flowWhere(filter));
  return {
    inAmount: row?.inAmount ?? '0',
    outAmount: row?.outAmount ?? '0',
    count: row?.count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// the order rows this domain reads and writes
// ---------------------------------------------------------------------------

export interface OrderPaymentRow {
  id: number;
  orderNo: string;
  userId: number;
  status: string;
  payableAmount: string;
  paidAmount: string | null;
  paidAt: Date | null;
  transactionNo: string | null;
  payExpiresAt: Date | null;
  platform: string;
  deletedAt: Date | null;
}

const orderColumns = {
  id: orders.id,
  orderNo: orders.orderNo,
  userId: orders.userId,
  status: orders.status,
  payableAmount: orders.payableAmount,
  paidAmount: orders.paidAmount,
  paidAt: orders.paidAt,
  transactionNo: orders.transactionNo,
  payExpiresAt: orders.payExpiresAt,
  platform: orders.platform,
  deletedAt: orders.deletedAt,
} as const;

export async function findOrderForPayment(
  db: DbOrTx,
  orderId: number,
): Promise<OrderPaymentRow | null> {
  const rows = await db.select(orderColumns).from(orders).where(eq(orders.id, orderId)).limit(1);
  return (rows[0] as OrderPaymentRow | undefined) ?? null;
}

export async function lockOrderForPayment(
  tx: Tx,
  orderId: number,
): Promise<OrderPaymentRow | null> {
  const rows = await tx
    .select(orderColumns)
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1)
    .for('update');
  return (rows[0] as OrderPaymentRow | undefined) ?? null;
}

/**
 * `pending_payment → paid`, in one statement.
 *
 * Deliberately *not* routed through `OrderStateMachine.transition`: the paid
 * transition has to write `paid_amount`, `paid_at` and `transaction_no` in the
 * same statement to satisfy `orders_paid_shape`, and it must be callable before
 * the order domain's implementation is registered. The guard is the same one
 * the state machine would use.
 */
export async function markOrderPaid(
  tx: DbOrTx,
  orderId: number,
  /** `transactionNo` is `null` for a zero-amount order, which no gateway saw. */
  patch: { paidAmount: string; paidAt: Date; transactionNo: string | null },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, orders, {
    where: and(eq(orders.id, orderId), eq(orders.status, 'pending_payment')),
    set: {
      status: 'paid',
      paidAmount: patch.paidAmount,
      paidAt: patch.paidAt,
      transactionNo: patch.transactionNo,
    },
  });
}

/** Orders whose payment window has closed and which still hold an open attempt. */
export async function listExpiredUnpaidOrders(
  db: DbOrTx,
  args: { now: Date; limit: number },
): Promise<Array<{ orderId: number }>> {
  const rows = await db
    .selectDistinct({ orderId: paymentAttempts.orderId })
    .from(paymentAttempts)
    .innerJoin(orders, eq(orders.id, paymentAttempts.orderId))
    .where(
      and(
        inArray(paymentAttempts.status, [...OPEN_ATTEMPT_STATUSES]),
        eq(orders.status, 'pending_payment'),
        lt(orders.payExpiresAt, args.now),
      ),
    )
    .limit(args.limit);
  return rows;
}
