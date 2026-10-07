import type { PageQuery } from '@shop/contracts/conventions';
import type {
  AdminRefundCreateBody,
  AdminRefundDetail,
  AdminRefundListItem,
  AdminRefundListQuery,
  AdminRefundWithdrawBody,
  RefundableItemsResult,
  RefundApproveBody,
  RefundReceiveReturnBody,
  RefundRejectBody,
  RefundRemarkBody,
} from '@shop/contracts/refund/schemas';
import type { Tx } from '@shop/db';
import { requirePermission } from '../auth/rbac';
import { recordEffect } from '../effects';
import { requireAdminId, type Ctx } from '../kernel/context';
import { UNEXPLAINED } from '../kernel/error-summary';
import { DomainError } from '../kernel/errors';
import { toId, toIdOrNull } from '../kernel/ids';
import { approvedRefundNote, notify } from '../notification';
import { refundPermissions } from './permissions';
import { returnAddress, type ReturnAddress } from './refund.config';
import * as repo from './refund.repo';
import { shopMayWithdraw } from './refund.rules';
import {
  executeRefund,
  openRefund,
  priceRequest,
  reconcileRefund,
  refreshOrderRefundStatus,
  refundableFor,
  refundableOrderPaid,
  returnDetail,
  toListItem,
  toLogEntry,
  type RefundItemWithSnapshot,
} from './refund.service';

/**
 * The after-sales console.
 *
 * Five decisions, and the split between the permission atoms is the split
 * between them: `request:review` says "this customer is owed money",
 * `request:execute` sends it. In a shop where customer service approves and
 * finance pays, that boundary is the control.
 *
 * No screen here sets an amount. The amount was computed from the frozen order
 * lines when the shopper applied, and re-pricing it afterwards is exactly the
 * defect REFUND-005 describes — so an operator's only choices are yes, no, the
 * goods came back, a note, and ask the gateway again.
 *
 * Approving does **not** send money. It records the decision and, for a
 * `refund_only`, an effect; the gateway call happens after that transaction has
 * committed, because an in-transaction refund would either give back money we
 * then rolled back or roll back a refund WeChat already made.
 */

export async function adminList(
  ctx: Ctx,
  query: AdminRefundListQuery,
): Promise<{ items: AdminRefundListItem[]; total: number; page: number; pageSize: number }> {
  requirePermission(ctx, refundPermissions['request:read']);
  return listRefunds(ctx, query);
}

async function listRefunds(
  ctx: Ctx,
  query: AdminRefundListQuery,
): Promise<{ items: AdminRefundListItem[]; total: number; page: number; pageSize: number }> {
  const { rows, total } = await repo.listAdminRefunds(ctx.db, {
    ...optional('status', asArray(query.status)),
    ...optional('kind', query.kind),
    ...optional('returnStage', query.returnStage),
    ...optional('orderId', query.orderId === undefined ? undefined : Number(query.orderId)),
    ...optional('userId', query.userId === undefined ? undefined : Number(query.userId)),
    ...optional('keyword', query.keyword),
    ...optional('createdFrom', toDate(query.createdFrom)),
    ...optional('createdTo', toDate(query.createdTo)),
    sort: query.sortBy ?? 'id',
    order: query.sortOrder ?? 'desc',
    ...pageBounds(query),
  });

  const items = await repo.listItemsForRefunds(
    ctx.db,
    rows.map((r) => r.id),
  );
  return {
    items: rows.map((row) => toAdminItem(row, items.get(row.id) ?? [])),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function adminDetail(ctx: Ctx, input: { id: string }): Promise<AdminRefundDetail> {
  requirePermission(ctx, refundPermissions['request:read']);
  return detail(ctx, Number(input.id));
}

/**
 * 同意退款.
 *
 * A `refund_only` goes straight on to the gateway through the effects ledger; a
 * `return_and_refund` waits at `awaiting_shipment` until somebody confirms the
 * goods are back. Both moves are one conditional update from `applied`, so an
 * approval racing the buyer's withdrawal ends with exactly one winner.
 *
 * This is also the moment the return address stops being a setting and becomes
 * a fact. The operator's own address wins (it needs `config:write` as well as
 * `request:review`), the configured one is the fallback, and whichever it is
 * gets written to `refunds.return_address` — so editing
 * 售后设置 next month cannot re-address a parcel that is already in the post.
 * With neither, a return is refused (`REFUND_RETURN_ADDRESS_MISSING`): an
 * approved return with no address leaves the buyer nowhere to send the goods.
 * The config is read *before* the transaction opens, because it can touch Redis
 * and a row lock is being held inside.
 */
export async function adminApprove(
  ctx: Ctx,
  input: { id: string } & RefundApproveBody,
): Promise<AdminRefundDetail> {
  requirePermission(ctx, refundPermissions['request:review']);
  // Sending one return somewhere other than 售后设置 is redirecting goods, which
  // is the after-sales owner's decision, not a reviewer's (`permissions.ts`).
  if (input.returnAddress !== undefined) requirePermission(ctx, refundPermissions['config:write']);
  return approveAs(ctx, requireAdminId(ctx), input);
}

/**
 * A review decision is the operator's: an `admins` row, stamped on
 * `refunds.reviewed_by_admin_id` and on the log entry (`operator_admin_id`).
 * (The mobile staff console, which reviewed as a `users` row, was deleted at
 * the cutover; its old log rows keep `operator_user_id`.)
 */
async function approveAs(
  ctx: Ctx,
  adminId: number,
  input: { id: string } & RefundApproveBody,
): Promise<AdminRefundDetail> {
  const id = Number(input.id);
  const address = input.returnAddress ?? (await returnAddress(ctx));

  await ctx.withTx(async (tx) => {
    const row = await repo.lockRefund(tx, id);
    if (!row) throw new DomainError('REFUND_NOT_FOUND');

    // Only a return needs an address, and only if one was never frozen: a
    // re-approval after 驳回 must not quietly move the parcel.
    if (row.kind === 'return_and_refund' && row.returnAddress === null && address === null) {
      throw new DomainError('REFUND_RETURN_ADDRESS_MISSING');
    }
    const freeze =
      row.kind === 'return_and_refund' && row.returnAddress === null && address !== null
        ? { returnAddress: address }
        : {};

    // A 仅退款 takes its units out of fulfilment in the same step
    // (`transitionRefund` with the approval bound; see `refusedShipped`).
    const { won, refusedLines } = await repo.transitionRefund(
      tx,
      id,
      ['applied'],
      'approved',
      {
        reviewedByAdminId: adminId,
        reviewedAt: ctx.clock.now(),
        ...freeze,
        ...(input.remark === undefined ? {} : { adminRemark: input.remark }),
      },
      'approval',
    );
    if (!won) throw new DomainError('REFUND_NOT_ACTIONABLE', { details: { status: row.status } });
    refusedShipped(refusedLines);

    await repo.insertLog(tx, {
      refundId: id,
      fromStatus: row.status,
      toStatus: 'approved',
      message: approvalMessage(row.kind, input.remark, freeze.returnAddress ?? null),
      operatorAdminId: adminId,
    });

    if (row.kind === 'refund_only') await queueExecution(tx, ctx, id);

    // Last, so that an approval the unit bound rolls back — the units went out
    // of the door first and the request is now a return — never tells the buyer
    // their refund was agreed.
    await notifyReview(tx, ctx, row, 'refund_approved', {
      amount: row.amount,
      refundNote: approvedRefundNote(row.amount, row.kind),
    });
  });

  return detail(ctx, id);
}

/**
 * The buyer's half of a review decision.
 *
 * `orderNo` is what the templates show — a shopper knows their order number,
 * not the refund's internal order id — and it is not on the refund row, so it
 * costs one read inside the transaction that already holds the lock.
 */
async function notifyReview(
  tx: Tx,
  ctx: Ctx,
  row: repo.RefundRow,
  event: 'refund_approved' | 'refund_rejected',
  extra: Record<string, unknown>,
): Promise<void> {
  const order = await repo.findOrder(tx, row.orderId);
  await notify(tx, ctx, {
    event,
    // The refund, not the order: one order can be refunded line by line, and
    // each request gets its own answer.
    subject: { scope: 'refund', id: row.id },
    userId: row.userId,
    data: {
      refundId: row.id,
      refundNo: row.refundNo,
      orderNo: order?.orderNo ?? '',
      ...extra,
    },
  });
}

/**
 * Approving a 仅退款 takes its units out of fulfilment there and then.
 *
 * The warehouse must not ship goods an operator has just agreed to refund, and
 * fulfilment's dispatch guard reads `quantity - refunded_quantity`, so the only
 * way to stop it is to raise that column now rather than when the money lands.
 * What the request may take is what it covered when the buyer applied: units
 * already shipped then are goods the buyer keeps (a money-only refund), units
 * shipped since are not the request's to take (`transitionRefund`'s approval
 * bound, under the order and line locks shipping takes too). An approval
 * racing a dispatch of the same units has exactly one winner whichever gets
 * there first (REFUND-021).
 *
 * Losing means the units went out of the door after the buyer asked. The
 * approval rolls back and the operator is told, which is right: the request is
 * now a return, not a refund.
 */
function refusedShipped(refusedLines: readonly number[]): void {
  const [first] = refusedLines;
  if (first === undefined) return;
  throw new DomainError('REFUND_LINE_ALREADY_SHIPPED', { details: { orderItemId: toId(first) } });
}

/**
 * The timeline entry says where the goods were asked to go, so the audit trail
 * stands on its own even if somebody later edits the row.
 */
function approvalMessage(
  kind: repo.RefundRow['kind'],
  remark: string | undefined,
  address: ReturnAddress | null,
): string {
  const head = kind === 'return_and_refund' ? '商家同意退货退款' : '商家同意退款';
  const note = remark === undefined ? '' : `：${remark}`;
  const where =
    address === null ? '' : `（退货地址：${address.name} ${address.phone} ${address.address}）`;
  return `${head}${note}${where}`.slice(0, 500);
}

export async function adminReject(
  ctx: Ctx,
  input: { id: string } & RefundRejectBody,
): Promise<AdminRefundDetail> {
  requirePermission(ctx, refundPermissions['request:review']);
  return rejectAs(ctx, requireAdminId(ctx), input);
}

async function rejectAs(
  ctx: Ctx,
  adminId: number,
  input: { id: string } & RefundRejectBody,
): Promise<AdminRefundDetail> {
  const id = Number(input.id);

  await ctx.withTx(async (tx) => {
    const row = await repo.lockRefund(tx, id);
    if (!row) throw new DomainError('REFUND_NOT_FOUND');

    // `refunds_rejected_needs_reason` makes the reason a database rule; the
    // contract makes it a required field. Both, because a rejection nobody can
    // explain later is the complaint that reaches the shop owner.
    //
    // From `failed` too: that is how a merchant closes a refund the gateway
    // keeps refusing (settled by hand, say), which frees its lines for a new
    // request (REFUND-017). An approved or failed 仅退款 hands its units back to
    // fulfilment in the same step (`transitionRefund`, REFUND-015).
    const { won } = await repo.transitionRefund(
      tx,
      id,
      ['applied', 'approved', 'failed'],
      'rejected',
      {
        reviewedByAdminId: adminId,
        reviewedAt: ctx.clock.now(),
        rejectReason: input.rejectReason,
      },
    );
    if (!won) throw new DomainError('REFUND_NOT_ACTIONABLE', { details: { status: row.status } });

    await repo.insertLog(tx, {
      refundId: id,
      fromStatus: row.status,
      toStatus: 'rejected',
      message:
        row.status === 'failed'
          ? `商家关闭售后：${input.rejectReason}`
          : `商家拒绝：${input.rejectReason}`,
      operatorAdminId: adminId,
    });
    await refreshOrderRefundStatus(tx, row.orderId);

    // The reason travels with it: a rejection the buyer cannot explain later is
    // the complaint that reaches the shop owner, and the database makes the
    // reason mandatory for the same reason.
    await notifyReview(tx, ctx, row, 'refund_rejected', { reason: input.rejectReason });
  });

  return detail(ctx, id);
}

/**
 * 确认收货并退款.
 *
 * Moves `approved → processing` and queues the gateway call. `processing` is
 * persisted *before* anything is sent, so a crash between the commit and the
 * call leaves a row the sweep will finish rather than a refund nobody knows
 * about.
 */
export async function adminReceiveReturn(
  ctx: Ctx,
  input: { id: string } & RefundReceiveReturnBody,
): Promise<AdminRefundDetail> {
  requirePermission(ctx, refundPermissions['request:execute']);
  const adminId = requireAdminId(ctx);
  const id = Number(input.id);

  await ctx.withTx(async (tx) => {
    const row = await repo.lockRefund(tx, id);
    if (!row) throw new DomainError('REFUND_NOT_FOUND');
    if (row.kind !== 'return_and_refund') throw new DomainError('REFUND_RETURN_NOT_EXPECTED');

    const { won } = await repo.transitionRefund(tx, id, ['approved'], 'processing', {
      returnStage: 'received',
      ...(input.remark === undefined ? {} : { adminRemark: input.remark }),
    });
    if (!won) throw new DomainError('REFUND_NOT_ACTIONABLE', { details: { status: row.status } });

    await repo.insertLog(tx, {
      refundId: id,
      fromStatus: row.status,
      toStatus: 'processing',
      message:
        input.remark === undefined ? '商家确认收到退货' : `商家确认收到退货：${input.remark}`,
      operatorAdminId: adminId,
    });
    await queueExecution(tx, ctx, id);
  });

  return detail(ctx, id);
}

export async function adminRemark(
  ctx: Ctx,
  input: { id: string } & RefundRemarkBody,
): Promise<AdminRefundDetail> {
  requirePermission(ctx, refundPermissions['request:write']);
  const id = Number(input.id);
  const row = await repo.findRefund(ctx.db, id);
  if (!row) throw new DomainError('REFUND_NOT_FOUND');
  await repo.setAdminRemark(ctx.db, id, input.adminRemark);
  return detail(ctx, id);
}

/**
 * 复核退款结果.
 *
 * Two different buttons behind one route, and which one runs is decided by the
 * row rather than by the operator: a refund that may be in flight is *queried*
 * by its frozen number, and one the gateway never took is *sent* again under
 * that same number. Nothing here ever mints a second refund number, which is
 * what makes this safe to press twice (REFUND-005 / REFUND-006).
 */
export async function adminRetry(ctx: Ctx, input: { id: string }): Promise<AdminRefundDetail> {
  requirePermission(ctx, refundPermissions['request:execute']);
  const id = Number(input.id);
  const row = await repo.findRefund(ctx.db, id);
  if (!row) throw new DomainError('REFUND_NOT_FOUND');

  if (row.status === 'succeeded') return detail(ctx, id);
  if (row.status === 'processing' || row.status === 'unknown') {
    const result = await reconcileRefund(ctx, id);
    if (result.status === 'unknown') {
      throw new DomainError('REFUND_STATE_UNKNOWN', { details: { message: result.message } });
    }
    return detail(ctx, id);
  }
  if (row.status === 'approved' || row.status === 'failed') {
    await executeRefund(ctx, id);
    return detail(ctx, id);
  }
  throw new DomainError('REFUND_NOT_ACTIONABLE', { details: { status: row.status } });
}

// ---------------------------------------------------------------------------
// 商家发起售后
// ---------------------------------------------------------------------------

/**
 * What the operator may still put into a new request on this order: the
 * buyer's apply screen, without the buyer.
 */
export async function adminApplicable(
  ctx: Ctx,
  input: { id: string },
): Promise<RefundableItemsResult> {
  requirePermission(ctx, refundPermissions['request:review']);
  const order = await repo.findOrder(ctx.db, Number(input.id));
  if (!order || order.deletedAt !== null) throw new DomainError('REFUND_ORDER_NOT_FOUND');
  return refundableFor(ctx, order, refundableOrderPaid(order));
}

/**
 * 商家发起售后.
 *
 * For the order the buyer can no longer apply on — completed, its after-sales
 * window gone — but the shop still owes something: a defect found later, a
 * complaint settled by phone. No window applies here; the operator is the
 * window.
 *
 * It is the buyer's request and the operator's 同意 in one transaction, through
 * the same steps: priced by `priceRequest` (lines and quantities, never an
 * amount — REFUND-005), inserted by `openRefund` (one open request per line),
 * then `applied → approved` with the approval unit bound, exactly as
 * `approveAs` moves it. So a 仅退款 goes to the gateway after commit, and a 退货
 * 退款 waits for the goods at the address in 售后设置, frozen on the row. The
 * buyer cannot withdraw it (`buyerMayWithdraw`); the shop can, while the goods
 * have not been sent (`adminWithdraw`).
 */
export async function adminCreate(
  ctx: Ctx,
  input: { id: string } & AdminRefundCreateBody,
): Promise<AdminRefundDetail> {
  requirePermission(ctx, refundPermissions['request:review']);
  const adminId = requireAdminId(ctx);
  const orderId = Number(input.id);
  // Read before the transaction, as `approveAs` does: it can touch Redis.
  const address = input.kind === 'return_and_refund' ? await returnAddress(ctx) : null;

  const refundId = await ctx.withTx(async (tx) => {
    const order = await repo.lockOrder(tx, orderId);
    if (!order || order.deletedAt !== null) throw new DomainError('REFUND_ORDER_NOT_FOUND');
    const paidAmount = refundableOrderPaid(order);
    if (input.kind === 'return_and_refund' && address === null) {
      throw new DomainError('REFUND_RETURN_ADDRESS_MISSING');
    }

    const priced = await priceRequest(tx, order, paidAmount, {
      lines: input.lines,
      includeFreight: input.includeFreight,
      // A 退货退款 gives back what the goods are worth; only a 仅退款 settles.
      amount: input.kind === 'refund_only' ? input.amount : undefined,
    });
    const refund = await openRefund(tx, ctx, {
      order,
      priced,
      kind: input.kind,
      reason: input.reason,
      explanation: null,
      images: [],
      initiatedByAdminId: adminId,
    });
    await repo.insertLog(tx, {
      refundId: refund.id,
      fromStatus: null,
      toStatus: 'applied',
      message:
        `商家发起${input.kind === 'return_and_refund' ? '退货退款' : '仅退款'}：${input.reason}`.slice(
          0,
          500,
        ),
      operatorAdminId: adminId,
    });

    const { won, refusedLines } = await repo.transitionRefund(
      tx,
      refund.id,
      ['applied'],
      'approved',
      {
        reviewedByAdminId: adminId,
        reviewedAt: ctx.clock.now(),
        ...(address === null ? {} : { returnAddress: address }),
        ...(input.remark === undefined ? {} : { adminRemark: input.remark }),
      },
      'approval',
    );
    // Inserted a moment ago under the order lock: nobody else can have moved it.
    if (!won) throw new Error('adminCreate: 新建的售后单无法转为已同意');
    refusedShipped(refusedLines);

    await repo.insertLog(tx, {
      refundId: refund.id,
      fromStatus: 'applied',
      toStatus: 'approved',
      // The staff note stays staff-only; the buyer reads this line.
      message: approvalMessage(input.kind, undefined, address),
      operatorAdminId: adminId,
    });
    if (input.kind === 'refund_only') await queueExecution(tx, ctx, refund.id);

    await notifyReview(tx, ctx, refund, 'refund_approved', {
      amount: refund.amount,
      refundNote: approvedRefundNote(refund.amount, refund.kind),
    });
    return refund.id;
  });

  return detail(ctx, refundId);
}

/**
 * 撤销 a refund the shop opened, while nothing has moved: a 退货退款 still
 * waiting for the buyer to send the goods (`shopMayWithdraw`). It ends
 * `cancelled` — the buyer reads 已撤销, not 商家已拒绝, because nobody asked —
 * and hands its lines back for a new request. A 仅退款 is at the gateway from
 * the moment it opens; one the gateway refused is closed through 驳回, as any
 * other failed refund is.
 */
export async function adminWithdraw(
  ctx: Ctx,
  input: { id: string } & AdminRefundWithdrawBody,
): Promise<AdminRefundDetail> {
  requirePermission(ctx, refundPermissions['request:review']);
  const adminId = requireAdminId(ctx);
  const id = Number(input.id);

  await ctx.withTx(async (tx) => {
    const row = await repo.lockRefund(tx, id);
    if (!row) throw new DomainError('REFUND_NOT_FOUND');
    if (!shopMayWithdraw(row)) {
      throw new DomainError('REFUND_NOT_ACTIONABLE', { details: { status: row.status } });
    }
    const { won } = await repo.transitionRefund(tx, id, ['approved'], 'cancelled', {
      cancelledAt: ctx.clock.now(),
    });
    if (!won) throw new DomainError('REFUND_NOT_ACTIONABLE', { details: { status: row.status } });

    await repo.insertLog(tx, {
      refundId: id,
      fromStatus: row.status,
      toStatus: 'cancelled',
      message: `商家撤销售后：${input.reason}`.slice(0, 500),
      operatorAdminId: adminId,
    });
    await refreshOrderRefundStatus(tx, row.orderId);
  });

  return detail(ctx, id);
}

// ---------------------------------------------------------------------------

/**
 * Records the "send this to WeChat" effect inside the caller's transaction.
 *
 * One row per refund, so an operator pressing 同意 twice queues one call; the
 * ledger's `(scope, scopeId, eventType)` uniqueness does that, not a check
 * here.
 */
async function queueExecution(tx: Tx, ctx: Ctx, refundId: number): Promise<void> {
  await recordEffect(tx, ctx, {
    scope: 'refund',
    scopeId: String(refundId),
    eventType: 'refund.execute',
    payload: { refundId: toId(refundId) },
  });
}

async function detail(ctx: Ctx, id: number): Promise<AdminRefundDetail> {
  const row = await repo.findAdminRefund(ctx.db, id);
  if (!row) throw new DomainError('REFUND_NOT_FOUND');
  const [items, logs, company] = await Promise.all([
    repo.listItemsForRefunds(ctx.db, [row.id]),
    repo.listLogs(ctx.db, row.id),
    row.returnExpressCompanyId === null
      ? Promise.resolve(null)
      : repo.findExpressCompany(ctx.db, row.returnExpressCompanyId),
  ]);
  const returns = returnDetail(row, company);

  return {
    ...toAdminItem(row, items.get(row.id) ?? []),
    explanation: returns.explanation,
    images: returns.images,
    returnExpressCompanyId: returns.returnExpressCompanyId,
    returnExpressCompanyName: returns.returnExpressCompanyName,
    returnTrackingNo: returns.returnTrackingNo,
    returnPhone: returns.returnPhone,
    returnAddress: returns.returnAddress,
    logs: logs.map(toLogEntry),
  };
}

function toAdminItem(
  row: repo.AdminRefundListRow,
  items: RefundItemWithSnapshot[],
): AdminRefundListItem {
  return {
    ...toListItem(row, items),
    // Narrower than the shopper's flag, which also covers 商家发起.
    isAutomatic: row.isAutomatic,
    initiatedByAdminId: toIdOrNull(row.initiatedByAdminId),
    initiatedByAdminName: row.initiatedByAdminName,
    userId: toId(row.userId),
    userNickname: row.userNickname,
    outRefundNo: row.outRefundNo,
    gatewayRefundId: row.gatewayRefundId,
    paymentAttemptId: toIdOrNull(row.paymentAttemptId),
    adminRemark: row.adminRemark,
    lastError: row.lastError,
    lastErrorSummary: lastErrorSummaryOf(row),
    reviewedByAdminId: toIdOrNull(row.reviewedByAdminId),
    reviewedAt: iso(row.reviewedAt),
    failedAt: iso(row.failedAt),
    cancelledAt: iso(row.cancelledAt),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * What staff read about the last failure. A row failed before summaries were
 * written has only the raw text, which stays under 技术详情.
 */
function lastErrorSummaryOf(row: repo.RefundRow): string | null {
  if (row.lastError === null) return null;
  return row.lastErrorSummary ?? `退款没有完成，${UNEXPLAINED}`;
}

function pageBounds(query: PageQuery): { offset: number; limit: number } {
  return { offset: (query.page - 1) * query.pageSize, limit: query.pageSize };
}
function asArray<T extends string>(value: T | readonly T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? [...value] : [value as T];
}
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
