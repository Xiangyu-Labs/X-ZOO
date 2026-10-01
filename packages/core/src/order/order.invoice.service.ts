import type {
  AdminInvoiceListQuery,
  InvoiceIssueBody,
  InvoiceOrderSummary,
  InvoiceRejectBody,
  InvoiceRequestBody,
  MyInvoiceListQuery,
  OrderInvoice,
} from '@shop/contracts/order/order.fulfil.schemas';
import { requireAdminId, requireUserId, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId, toId } from '../kernel/ids';
import { Money } from '../kernel/money';
import * as fulfilRepo from './order.fulfil.repo';
import { requireOrderRef } from './order.ref';
import * as repo from './order.repo';
import { checkText } from '../wechat';

/**
 * 发票.
 *
 * An invoice row that copied the order — its amount, address and items — would
 * drift from it the moment anything was refunded. So the row carries only the
 * *header* (who the invoice is made out to, frozen at request time) plus the
 * amount, and everything else is read from the order.
 *
 * Three rules, all enforced by the database rather than by a prior SELECT:
 *
 *  1. **One live request per order.** `order_invoices_open_uq` is a partial
 *     unique index over `status in ('requested','issued')`, so a double-tap on
 *     申请开票 raises a constraint violation that becomes
 *     `ORDER_INVOICE_ALREADY_OPEN`. A cancelled or rejected request may be
 *     re-submitted, which the partial index allows and a plain unique would
 *     not.
 *  2. **Issued means numbered.** `order_invoices_issued_shape` requires
 *     `issued_at` and `invoice_number` together, so there is no such thing as
 *     an issued invoice nobody can look up.
 *  3. **Every status change is a conditional update.** Two operators pressing
 *     开票 and 驳回 at the same instant cannot both win.
 *
 * There is no e-invoice provider integration; an operator types the number from
 * whatever system actually issued it.
 */

// ---------------------------------------------------------------------------
// wire mapping
// ---------------------------------------------------------------------------

type InvoiceRow = fulfilRepo.InvoiceWithOrder;

/**
 * What the order was for, for the 发票记录 row.
 *
 * Read from `order_items` every time rather than copied onto the invoice: the
 * invoice row carries the header and the amount, and nothing that could drift
 * away from the order it points at. One query covers a whole page of invoices.
 */
async function summarise(
  ctx: Ctx,
  orderIds: readonly number[],
): Promise<Map<number, InvoiceOrderSummary>> {
  const out = new Map<number, InvoiceOrderSummary>();
  if (orderIds.length === 0) return out;

  // `listItems` orders by id, so the first row of each order is the line the
  // buyer added first — the same one the order list renders.
  for (const item of await repo.listItems(ctx.db, orderIds)) {
    const seen = out.get(item.orderId);
    if (seen) {
      seen.lineCount += 1;
      seen.totalQuantity += item.quantity;
      continue;
    }
    out.set(item.orderId, {
      productName: item.snapshot.productName,
      productImageUrl: item.snapshot.skuImageUrl ?? item.snapshot.productImageUrl,
      specText: item.snapshot.specText,
      quantity: item.quantity,
      lineCount: 1,
      totalQuantity: item.quantity,
    });
  }
  return out;
}

function toWire(row: InvoiceRow, orderSummary: InvoiceOrderSummary | null): OrderInvoice {
  return {
    id: toId(row.id),
    orderId: toId(row.orderId),
    orderNo: row.orderNo,
    userId: toId(row.userId),
    status: row.status,
    headerType: row.headerType,
    invoiceType: row.invoiceType,
    name: row.name,
    dutyNumber: row.dutyNumber,
    drawerPhone: row.drawerPhone,
    email: row.email,
    registeredTel: row.registeredTel,
    registeredAddress: row.registeredAddress,
    bankName: row.bankName,
    bankAccount: row.bankAccount,
    amount: row.amount,
    invoiceNumber: row.invoiceNumber,
    remark: row.remark,
    orderSummary,
    orderRefundedInFull: refundedInFull(row.order),
    voided: row.status === 'cancelled' && row.invoiceNumber !== null,
    issuedAt: row.issuedAt === null ? null : row.issuedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

async function readInvoice(ctx: Ctx, id: number): Promise<OrderInvoice> {
  const row = await fulfilRepo.findInvoiceWithOrderNo(ctx.db, id);
  if (!row) throw new DomainError('ORDER_INVOICE_NOT_FOUND');
  const [wired] = await withSummaries(ctx, [row]);
  return wired!;
}

/** One `order_items` read behind a whole page of invoices. */
async function withSummaries(ctx: Ctx, rows: readonly InvoiceRow[]): Promise<OrderInvoice[]> {
  const summaries = await summarise(
    ctx,
    rows.map((row) => row.orderId),
  );
  return rows.map((row) => toWire(row, summaries.get(row.orderId) ?? null));
}

const asArray = <T>(value: T | readonly T[] | undefined): readonly T[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value as T];

const asDate = (value: string | undefined): Date | undefined =>
  value === undefined ? undefined : new Date(value);

// ---------------------------------------------------------------------------
// the buyer
// ---------------------------------------------------------------------------

/**
 * 申请开票.
 *
 * Only on an order that has been paid for and not refunded: an invoice for
 * money that came back is a tax problem, and an invoice for money that never
 * arrived is a different one.
 */
/** Paid, less every refund that has succeeded. */
export function invoiceableAmount(order: {
  paidAmount: string | null;
  refundedAmount: string;
}): Money {
  if (order.paidAmount === null) return Money.ZERO;
  return Money.parse(order.paidAmount).sub(Money.parse(order.refundedAmount)).clampToZero();
}

/**
 * INVOICE-005: every yuan the order collected has come back. An invoice already
 * issued stays 已开票 — a refund does not undo it in the tax system — and the
 * admin says 订单已全额退款，请到税务系统冲红 until staff mark it 已作废.
 */
export function refundedInFull(order: {
  status: string;
  refundStatus: string;
  paidAmount: string | null;
  refundedAmount: string;
}): boolean {
  if (order.status === 'refunded' || order.refundStatus === 'refunded') return true;
  return order.paidAmount !== null && !invoiceableAmount(order).isPositive();
}

/**
 * INVOICE-004: whether 申请开票 would be accepted for this order — paid, not refunded in
 * full, something left to invoice, and no request already 待开票 or 已开票. `request` refuses
 * exactly what this says no to, so 订单详情 can hide the button instead of learning it from a
 * refusal.
 */
export function isInvoiceRequestable(
  order: {
    status: string;
    refundStatus: string;
    paidAt: Date | null;
    paidAmount: string | null;
    refundedAmount: string;
  },
  hasOpenInvoice: boolean,
): boolean {
  if (hasOpenInvoice) return false;
  if (order.paidAt === null || order.paidAmount === null) return false;
  if (order.status === 'refunded' || order.refundStatus === 'refunded') return false;
  return invoiceableAmount(order).isPositive();
}

export async function request(
  ctx: Ctx,
  params: { id: string },
  body: InvoiceRequestBody,
): Promise<OrderInvoice> {
  const { orderId, userId } = await requireOrderRef(ctx, params.id);
  // 内容安全 (C09, CONTENT-003): the 抬头 is screened by WeChat before anything
  // is written. `risky` refuses it; WeChat unreachable lets it through.
  const verdict = await checkText(ctx, {
    userId,
    content: body.name,
    scene: 1,
    what: 'invoice-title',
  });
  if (verdict === 'risky') throw new DomainError('ORDER_INVOICE_TITLE_REJECTED');

  const invoiceId = await ctx.withTx(async (tx): Promise<number> => {
    const order = await repo.findOrderForUser(tx, { id: orderId, userId });
    if (!order) throw new DomainError('ORDER_NOT_FOUND');
    // An open request is not asked about here: the partial unique index below is that check.
    if (!isInvoiceRequestable(order, false)) {
      throw new DomainError('ORDER_INVOICE_NOT_REQUESTABLE', {
        details: { status: order.status, refundStatus: order.refundStatus },
      });
    }
    const amount = invoiceableAmount(order);

    try {
      const invoice = await fulfilRepo.insertInvoice(tx, {
        orderId,
        userId,
        status: 'requested',
        headerType: body.headerType,
        invoiceType: body.invoiceType,
        name: body.name,
        dutyNumber: body.dutyNumber ?? null,
        drawerPhone: body.drawerPhone ?? null,
        email: body.email ?? null,
        registeredTel: body.registeredTel ?? null,
        registeredAddress: body.registeredAddress ?? null,
        bankName: body.bankName ?? null,
        bankAccount: body.bankAccount ?? null,
        // What the buyer actually paid, less anything already refunded.
        amount: amount.toString(),
        remark: body.remark ?? null,
      });

      await repo.insertStatusLog(tx, {
        orderId,
        changeType: 'invoice_requested',
        message: `申请开票 ${body.name}`.slice(0, 512),
        operatorKind: 'user',
        operatorUserId: userId,
      });
      return invoice.id;
    } catch (error) {
      // The partial unique index is the check. Asking first would be a
      // read-then-write with a race in the gap.
      if (fulfilRepo.isOpenInvoiceConflict(error)) {
        throw new DomainError('ORDER_INVOICE_ALREADY_OPEN');
      }
      throw error;
    }
  });

  return readInvoice(ctx, invoiceId);
}

export async function myList(
  ctx: Ctx,
  query: MyInvoiceListQuery,
): Promise<{ items: OrderInvoice[]; total: number; page: number; pageSize: number }> {
  const userId = requireUserId(ctx);
  const { rows, total } = await fulfilRepo.listInvoices(ctx.db, {
    filter: { userId, status: asArray(query.status) },
    offset: (query.page - 1) * query.pageSize,
    limit: query.pageSize,
  });
  return {
    items: await withSummaries(ctx, rows),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function myDetail(ctx: Ctx, params: { id: string }): Promise<OrderInvoice> {
  const userId = requireUserId(ctx);
  const row = await fulfilRepo.findInvoiceWithOrderNo(ctx.db, fromId(params.id));
  // A stranger's invoice and a missing one are the same answer (AUTH-005).
  if (!row || row.userId !== userId) throw new DomainError('ORDER_INVOICE_NOT_FOUND');
  const [wired] = await withSummaries(ctx, [row]);
  return wired!;
}

/** The buyer withdraws a request that has not been issued yet. */
export async function cancel(ctx: Ctx, params: { id: string }): Promise<OrderInvoice> {
  const userId = requireUserId(ctx);
  const invoiceId = fromId(params.id);

  await ctx.withTx(async (tx) => {
    const row = await fulfilRepo.findInvoice(tx, invoiceId);
    if (!row || row.userId !== userId) throw new DomainError('ORDER_INVOICE_NOT_FOUND');
    const moved = await fulfilRepo.transitionInvoice(tx, {
      invoiceId,
      from: ['requested'],
      to: 'cancelled',
    });
    if (!moved.won) throw new DomainError('ORDER_INVOICE_NOT_ACTIONABLE');
  });

  return readInvoice(ctx, invoiceId);
}

// ---------------------------------------------------------------------------
// the operator
// ---------------------------------------------------------------------------

export async function adminList(
  ctx: Ctx,
  query: AdminInvoiceListQuery,
): Promise<{ items: OrderInvoice[]; total: number; page: number; pageSize: number }> {
  const { rows, total } = await fulfilRepo.listInvoices(ctx.db, {
    filter: {
      status: asArray(query.status),
      headerType: query.headerType,
      invoiceType: query.invoiceType,
      keyword: query.keyword,
      userId: query.userId === undefined ? undefined : fromId(query.userId),
      createdFrom: asDate(query.createdFrom),
      createdTo: asDate(query.createdTo),
    },
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    offset: (query.page - 1) * query.pageSize,
    limit: query.pageSize,
  });
  return {
    items: await withSummaries(ctx, rows),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function adminDetail(ctx: Ctx, params: { id: string }): Promise<OrderInvoice> {
  return readInvoice(ctx, fromId(params.id));
}

/** 开票. The number the operator types is what the buyer will quote back. */
export async function adminIssue(
  ctx: Ctx,
  params: { id: string },
  body: InvoiceIssueBody,
): Promise<OrderInvoice> {
  const adminId = requireAdminId(ctx);
  const invoiceId = fromId(params.id);
  const now = ctx.clock.now();

  await ctx.withTx(async (tx) => {
    const row = await fulfilRepo.findInvoice(tx, invoiceId);
    if (!row) throw new DomainError('ORDER_INVOICE_NOT_FOUND');
    // The amount frozen at the request is re-read here: a refund that landed
    // in between is money the shop no longer has, and it must not be on the
    // invoice. The order row is locked so a refund cannot land mid-issue.
    const order = await repo.lockOrder(tx, row.orderId);
    const amount = order ? invoiceableAmount(order) : Money.ZERO;
    if (!amount.isPositive()) {
      throw new DomainError('ORDER_INVOICE_NOT_ACTIONABLE', {
        details: { status: row.status, refundStatus: order?.refundStatus ?? null },
      });
    }

    const moved = await fulfilRepo.transitionInvoice(tx, {
      invoiceId,
      from: ['requested'],
      to: 'issued',
      set: {
        amount: amount.toString(),
        invoiceNumber: body.invoiceNumber,
        issuedAt: now,
        issuedByAdminId: adminId,
        ...(body.remark === undefined ? {} : { remark: body.remark }),
      },
    });
    if (!moved.won) throw new DomainError('ORDER_INVOICE_NOT_ACTIONABLE');

    await repo.insertStatusLog(tx, {
      orderId: row.orderId,
      changeType: 'invoice_issued',
      message: `开票 ${body.invoiceNumber}`.slice(0, 512),
      operatorKind: 'admin',
      operatorAdminId: adminId,
    });
  });

  return readInvoice(ctx, invoiceId);
}

/** 驳回. The reason is required — the buyer is told, and told why. */
export async function adminReject(
  ctx: Ctx,
  params: { id: string },
  body: InvoiceRejectBody,
): Promise<OrderInvoice> {
  const adminId = requireAdminId(ctx);
  const invoiceId = fromId(params.id);

  await ctx.withTx(async (tx) => {
    const row = await fulfilRepo.findInvoice(tx, invoiceId);
    if (!row) throw new DomainError('ORDER_INVOICE_NOT_FOUND');

    const moved = await fulfilRepo.transitionInvoice(tx, {
      invoiceId,
      from: ['requested'],
      to: 'rejected',
      set: { remark: body.reason },
    });
    if (!moved.won) throw new DomainError('ORDER_INVOICE_NOT_ACTIONABLE');

    await repo.insertStatusLog(tx, {
      orderId: row.orderId,
      changeType: 'invoice_rejected',
      message: `驳回开票: ${body.reason}`.slice(0, 512),
      operatorKind: 'admin',
      operatorAdminId: adminId,
    });
  });

  return readInvoice(ctx, invoiceId);
}

/**
 * 作废 (INVOICE-005). Records that staff reversed an issued invoice in the tax
 * system (冲红); nothing is sent anywhere. The row becomes `cancelled` keeping its
 * number — `issued_at` goes, since `order_invoices_issued_shape` gives only an
 * `issued` row one — which frees the order to ask again for what is left.
 */
export async function adminVoid(ctx: Ctx, params: { id: string }): Promise<OrderInvoice> {
  const adminId = requireAdminId(ctx);
  const invoiceId = fromId(params.id);

  await ctx.withTx(async (tx) => {
    const row = await fulfilRepo.findInvoice(tx, invoiceId);
    if (!row) throw new DomainError('ORDER_INVOICE_NOT_FOUND');

    const moved = await fulfilRepo.transitionInvoice(tx, {
      invoiceId,
      from: ['issued'],
      to: 'cancelled',
      set: { issuedAt: null },
    });
    if (!moved.won) {
      throw new DomainError('ORDER_INVOICE_NOT_ACTIONABLE', { details: { status: row.status } });
    }

    await repo.insertStatusLog(tx, {
      orderId: row.orderId,
      changeType: 'invoice_voided',
      message: `作废发票 ${row.invoiceNumber ?? ''}`.trim().slice(0, 512),
      operatorKind: 'admin',
      operatorAdminId: adminId,
    });
  });

  return readInvoice(ctx, invoiceId);
}
