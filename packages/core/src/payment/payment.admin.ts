import type {
  CapitalFlowListItem,
  CapitalFlowListQuery,
  CapitalFlowSummary,
  CapitalFlowSummaryQuery,
  PaymentAttemptListItem,
  PaymentAttemptListQuery,
  PaymentEffectListItem,
  PaymentEffectListQuery,
  PaymentEffectRetryResult,
  PaymentExceptionDetail,
  PaymentExceptionListItem,
  PaymentExceptionListQuery,
} from '@shop/contracts/payment/schemas';
import { paymentEffectScopes } from '@shop/contracts/payment/schemas';
import type { PageQuery } from '@shop/contracts/conventions';
import { requirePermission } from '../auth/rbac';
import { requireAdminId, type Ctx } from '../kernel/context';
import { SummarizedError, UNEXPLAINED } from '../kernel/error-summary';
import { DomainError } from '../kernel/errors';
import { toId, toIdOrNull } from '../kernel/ids';
import { Money } from '../kernel/money';
import { paymentPermissions } from './permissions';
import {
  effectErrorSummary,
  findEffectById,
  listEffects,
  retryEffect,
  retryMessage,
  type EffectConsoleRow,
} from '../effects';
import * as repo from './payment.repo';
import { recheckException, refundException } from './payment.service';

/**
 * The operator console.
 *
 * Three screens, and the split between them is the split between "what
 * happened" and "do something about it": 支付记录 and 资金流水 are reports,
 * 异常支付 is the only place in the admin where a button moves money, which is
 * why it has its own permission atom.
 *
 * Nothing here returns a secret. The exception detail carries the gateway's
 * own answer (`refundRequest`) and the frozen payment context — trade type,
 * openid, client ip — because that is what an operator needs to talk to WeChat
 * support, and never the API key, the certificate or the private key.
 */

// ---------------------------------------------------------------------------
// attempts
// ---------------------------------------------------------------------------

export async function adminListAttempts(
  ctx: Ctx,
  query: PaymentAttemptListQuery,
): Promise<{ items: PaymentAttemptListItem[]; total: number; page: number; pageSize: number }> {
  requirePermission(ctx, paymentPermissions['attempt:read']);
  const { rows, total } = await repo.listAttempts(ctx.db, {
    ...optional('orderId', query.orderId === undefined ? undefined : Number(query.orderId)),
    ...optional('outTradeNo', query.outTradeNo),
    ...optional('transactionId', query.transactionId),
    ...optional('status', asArray(query.status)),
    ...optional('channel', query.channel),
    ...optional('createdFrom', toDate(query.createdFrom)),
    ...optional('createdTo', toDate(query.createdTo)),
    sort: query.sortBy ?? 'id',
    order: query.sortOrder ?? 'desc',
    ...pageBounds(query),
  });
  return { items: rows.map(toAttemptItem), total, page: query.page, pageSize: query.pageSize };
}

function toAttemptItem(row: repo.AttemptListRow): PaymentAttemptListItem {
  return {
    id: toId(row.id),
    orderId: toId(row.orderId),
    orderNo: row.orderNo ?? '',
    outTradeNo: row.outTradeNo,
    channel: row.channel,
    status: row.status,
    mchId: row.mchId,
    amount: row.amount,
    transactionId: row.transactionId,
    payerUserId: toIdOrNull(row.payerUserId),
    lastResult: row.lastResult,
    paidAt: iso(row.paidAt),
    closedConfirmedAt: iso(row.closedConfirmedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// exceptions
// ---------------------------------------------------------------------------

export async function adminListExceptions(
  ctx: Ctx,
  query: PaymentExceptionListQuery,
): Promise<{ items: PaymentExceptionListItem[]; total: number; page: number; pageSize: number }> {
  requirePermission(ctx, paymentPermissions['exception:read']);
  const { rows, total } = await repo.listExceptions(ctx.db, {
    ...optional('status', asArray(query.status)),
    ...optional('reason', query.reason),
    ...optional('keyword', query.keyword),
    ...optional('createdFrom', toDate(query.createdFrom)),
    ...optional('createdTo', toDate(query.createdTo)),
    sort: query.sortBy ?? 'id',
    order: query.sortOrder ?? 'desc',
    ...pageBounds(query),
  });
  return { items: rows.map(toExceptionItem), total, page: query.page, pageSize: query.pageSize };
}

/**
 * 「异常待处理」's 异常支付: rows whose money a person still has to refund or let
 * go. 退款中 is not counted — it is waiting on WeChat, not on anybody here.
 */
export function countExceptionsAwaitingAction(ctx: Ctx): Promise<number> {
  return repo.countActionableExceptions(ctx.db);
}

export async function adminExceptionDetail(
  ctx: Ctx,
  input: { id: string },
): Promise<PaymentExceptionDetail> {
  requirePermission(ctx, paymentPermissions['exception:read']);
  return exceptionDetail(ctx, Number(input.id));
}

/**
 * The 原路退回 button.
 *
 * It calls the same function the automatic effect calls, so the manual path and
 * the automatic one cannot drift: the refund number is frozen on the row, a
 * second press asks the gateway about the same refund, and the operator's id
 * ends up on the row either way.
 */
export async function adminRefundException(
  ctx: Ctx,
  input: { id: string; note?: string },
): Promise<PaymentExceptionDetail> {
  requirePermission(ctx, paymentPermissions['exception:handle']);
  const adminId = requireAdminId(ctx);
  try {
    await refundException(ctx, Number(input.id), {
      operatorAdminId: adminId,
      ...(input.note === undefined ? {} : { note: input.note }),
    });
  } catch (error) {
    // `handle()` answers anything that is not a DomainError with a bare 500;
    // the button's toast should say what the row now says.
    if (error instanceof SummarizedError) {
      throw new DomainError('PAYMENT_STATE_UNKNOWN', { message: error.summary, cause: error });
    }
    throw error;
  }
  return exceptionDetail(ctx, Number(input.id));
}

/**
 * "We keep this money, and here is why."
 *
 * The note is mandatory in the contract: an ignored exception is a decision
 * somebody has to be able to defend later, and an empty reason makes the row
 * worthless.
 */
export async function adminIgnoreException(
  ctx: Ctx,
  input: { id: string; note: string },
): Promise<PaymentExceptionDetail> {
  requirePermission(ctx, paymentPermissions['exception:handle']);
  const adminId = requireAdminId(ctx);
  const id = Number(input.id);

  await ctx.withTx(async (tx) => {
    const row = await repo.lockException(tx, id);
    if (!row) throw new DomainError('PAYMENT_EXCEPTION_NOT_FOUND');
    const { won } = await repo.ignoreException(tx, id, {
      at: ctx.clock.now(),
      operatorAdminId: adminId,
      note: input.note,
    });
    if (!won) {
      throw new DomainError('PAYMENT_EXCEPTION_NOT_ACTIONABLE', {
        details: { status: row.status },
      });
    }
  });
  return exceptionDetail(ctx, id);
}

/** Asks the gateway what became of a refund whose answer was lost. */
export async function adminRecheckException(
  ctx: Ctx,
  input: { id: string },
): Promise<PaymentExceptionDetail> {
  requirePermission(ctx, paymentPermissions['exception:handle']);
  await recheckException(ctx, Number(input.id));
  return exceptionDetail(ctx, Number(input.id));
}

async function exceptionDetail(ctx: Ctx, id: number): Promise<PaymentExceptionDetail> {
  const row = await repo.findException(ctx.db, id);
  if (!row) throw new DomainError('PAYMENT_EXCEPTION_NOT_FOUND');
  const order = row.orderId === null ? null : await repo.findOrderForPayment(ctx.db, row.orderId);
  return {
    ...toExceptionItem({ ...row, orderNo: order?.orderNo ?? null }),
    refundRequest: row.refundRequest ?? null,
    context: { ...row.context } as Record<string, unknown>,
  };
}

function toExceptionItem(row: repo.ExceptionListRow): PaymentExceptionListItem {
  return {
    id: toId(row.id),
    orderId: toIdOrNull(row.orderId),
    orderNo: row.orderNo,
    paymentAttemptId: toIdOrNull(row.paymentAttemptId),
    mchId: row.mchId,
    transactionId: row.transactionId,
    outTradeNo: row.outTradeNo,
    reason: row.reason,
    status: row.status,
    paidAmount: row.paidAmount,
    refundNo: row.refundNo,
    operatorAdminId: toIdOrNull(row.operatorAdminId),
    note: row.note,
    refundedAt: iso(row.refundedAt),
    resolvedAt: iso(row.resolvedAt),
    alarmedAt: iso(row.alarmedAt),
    createdAt: row.createdAt.toISOString(),
    ...lastRefundError(row),
  };
}

/**
 * Why the refund has not gone back, for a row that is still waiting on one
 * (`refund_failed`, `refund_unknown`): the Chinese line and the raw text, read
 * off the `refund_request` the failing code wrote. A settled or ignored row
 * has nothing to explain, whatever an earlier attempt said.
 */
function lastRefundError(row: repo.ExceptionRow): {
  lastError: string | null;
  lastErrorSummary: string | null;
} {
  const none = { lastError: null, lastErrorSummary: null };
  if (row.status !== 'refund_failed' && row.status !== 'refund_unknown') return none;
  const { error, summary } = (row.refundRequest ?? {}) as { error?: unknown; summary?: unknown };
  const raw = typeof error === 'string' && error !== '' ? error : null;
  const words = typeof summary === 'string' && summary !== '' ? summary : null;
  // A row written before the summary existed (or by a path that records none)
  // still says something a person can act on.
  if (words === null && raw === null && row.status === 'refund_failed') {
    return { lastError: null, lastErrorSummary: `退款没有成功，${UNEXPLAINED}` };
  }
  return { lastError: raw, lastErrorSummary: words };
}

// ---------------------------------------------------------------------------
// capital flows
// ---------------------------------------------------------------------------

export async function adminListFlows(
  ctx: Ctx,
  query: CapitalFlowListQuery,
): Promise<{ items: CapitalFlowListItem[]; total: number; page: number; pageSize: number }> {
  requirePermission(ctx, paymentPermissions['flow:read']);
  const { rows, total } = await repo.listCapitalFlows(ctx.db, flowFilter(query));
  return { items: rows.map(toFlowItem), total, page: query.page, pageSize: query.pageSize };
}

/**
 * The numbers above the table, over the *whole* filter rather than the page.
 * `netAmount` is in − out and may be negative, which the wire type allows
 * because a day of refunds is a real thing that happens.
 */
export async function adminFlowSummary(
  ctx: Ctx,
  query: CapitalFlowSummaryQuery,
): Promise<CapitalFlowSummary> {
  requirePermission(ctx, paymentPermissions['flow:read']);
  // The summary covers the whole filter, so it is the one list query with no
  // page: `pageBounds` gets a window big enough to be meaningless because the
  // repo aggregates rather than selects.
  const totals = await repo.summariseCapitalFlows(
    ctx.db,
    flowFilter({ ...query, page: 1, pageSize: 1 }),
  );
  const inAmount = Money.parse(normalise(totals.inAmount));
  const outAmount = Money.parse(normalise(totals.outAmount));
  return {
    inAmount: inAmount.toString(),
    outAmount: outAmount.toString(),
    netAmount: inAmount.sub(outAmount).toString(),
    count: totals.count,
  };
}

function flowFilter(query: CapitalFlowListQuery): repo.FlowListFilter {
  return {
    ...optional('kind', asArray(query.kind)),
    ...optional('direction', query.direction),
    ...optional('orderId', query.orderId === undefined ? undefined : Number(query.orderId)),
    ...optional('userId', query.userId === undefined ? undefined : Number(query.userId)),
    ...optional('keyword', query.keyword),
    ...optional('occurredFrom', toDate(query.occurredFrom)),
    ...optional('occurredTo', toDate(query.occurredTo)),
    sort: query.sortBy ?? 'occurredAt',
    order: query.sortOrder ?? 'desc',
    ...pageBounds(query),
  };
}

function toFlowItem(row: repo.FlowListRow): CapitalFlowListItem {
  return {
    id: toId(row.id),
    kind: row.kind,
    reference: row.reference,
    direction: row.direction,
    amount: row.amount,
    orderId: toIdOrNull(row.orderId),
    orderNo: row.orderNo,
    userId: toIdOrNull(row.userId),
    mchId: row.mchId,
    transactionId: row.transactionId,
    note: row.note,
    occurredAt: row.occurredAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// the "needs a human" console
// ---------------------------------------------------------------------------

/**
 * The scopes this console may show: every one whose parked effect is work left
 * undone (`paymentEffectScopes`), not the notification send log.
 */
const EFFECT_SCOPES = paymentEffectScopes;

export async function adminListEffects(
  ctx: Ctx,
  query: PaymentEffectListQuery,
): Promise<{ items: PaymentEffectListItem[]; total: number; page: number; pageSize: number }> {
  requirePermission(ctx, paymentPermissions['effect:handle']);
  const { rows, total } = await listEffects(ctx.db, {
    scopes: EFFECT_SCOPES,
    status: query.status,
    page: query.page,
    pageSize: query.pageSize,
    ...optional('scope', query.scope),
    ...optional('eventType', query.eventType),
  });
  return { items: rows.map(toEffectItem), total, page: query.page, pageSize: query.pageSize };
}

/**
 * Un-parks one effect.
 *
 * The handler is *not* run here. A parked effect is parked because it kept
 * failing, its handler talks to WeChat, and an admin HTTP request is the wrong
 * place to wait for that. The row goes back to `pending` with `next_run_at =
 * now` and the dispatcher picks it up within its poll interval — so
 * `succeeded` in the result means "re-queued", and the message says so.
 */
export async function adminRetryEffect(
  ctx: Ctx,
  input: { id: string },
): Promise<PaymentEffectRetryResult> {
  requirePermission(ctx, paymentPermissions['effect:handle']);
  const id = Number(input.id);
  const row = await findEffectById(ctx.db, id, EFFECT_SCOPES);
  if (!row) throw new DomainError('PAYMENT_EFFECT_NOT_FOUND');

  const { won } = await retryEffect(ctx.db, id, ctx.clock.now());
  const fresh = (await findEffectById(ctx.db, id, EFFECT_SCOPES)) ?? row;
  return {
    effect: toEffectItem(fresh),
    succeeded: won,
    message: retryMessage(won, fresh.status, '该任务'),
  };
}

function toEffectItem(row: EffectConsoleRow): PaymentEffectListItem {
  const status: PaymentEffectListItem['status'] =
    row.status === 'done' ? 'done' : row.status === 'unknown' ? 'unknown' : 'pending';
  return {
    id: toId(row.id),
    scope: row.scope,
    scopeId: row.scopeId,
    eventType: row.eventType,
    status,
    attempts: row.attempts,
    lastError: row.lastError,
    lastErrorSummary: effectErrorSummary(row),
    nextRunAt: row.nextRunAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pageBounds(query: PageQuery): { offset: number; limit: number } {
  return { offset: (query.page - 1) * query.pageSize, limit: query.pageSize };
}

/** `status=a&status=b` reaches the service as an array; one value as a scalar. */
function asArray<T extends string>(value: T | readonly T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? [...value] : [value as T];
}

/**
 * `exactOptionalPropertyTypes` means an explicit `undefined` is not the same as
 * an absent key, so optional filters are spread in rather than assigned.
 */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function toDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed);
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** PostgreSQL prints `sum(numeric)` without trailing zeros; `Money` wants two. */
function normalise(value: string): string {
  return value.includes('.') ? value : `${value}.00`;
}
