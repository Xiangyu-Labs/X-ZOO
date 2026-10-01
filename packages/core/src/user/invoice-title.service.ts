import type { PageQuery } from '@shop/contracts/conventions';
import type { InvoiceTitle, InvoiceTitleForm } from '@shop/contracts/user/schemas';
import { requireUserId, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fromId, toId } from '../kernel/ids';
import { checkText } from '../wechat';
import {
  INVOICE_TITLE_LIMIT,
  blankToNull,
  invoiceTitleProblems,
  pageBounds,
  shouldForceDefault,
} from './user.rules';
import * as repo from './user.repo';

/**
 * The shopper's 发票抬头 book (`/api/v1/invoice-titles`).
 *
 * Scoped to `requireUserId(ctx)` like the address book: no function here takes
 * a user id, and every read and write names the owner in its `WHERE`, so a
 * title that is somebody else's is indistinguishable from one that does not
 * exist.
 *
 * Every write takes `repo.lockInvoiceTitleBook` first. That is what makes the
 * cap and the single default hold when the same customer taps 保存 twice or
 * promotes two titles at once (USER-016): the writers queue on the lock and
 * each one sees the last one's result, instead of both counting 19 or both
 * clearing a flag the other is about to set.
 *
 * The order domain never reads this. A client prefills
 * `POST /orders/:id/invoice` by copying a title's fields
 * (`invoiceRequestFromTitle` in the contracts), and the request freezes them.
 */

export async function invoiceTitleList(
  ctx: Ctx,
  query: PageQuery,
): Promise<{ items: InvoiceTitle[]; total: number; page: number; pageSize: number }> {
  const userId = requireUserId(ctx);
  const [rows, total] = await Promise.all([
    repo.listInvoiceTitles(ctx.db, { userId, ...pageBounds(query) }),
    repo.countInvoiceTitles(ctx.db, userId),
  ]);
  return { items: rows.map(toInvoiceTitle), total, page: query.page, pageSize: query.pageSize };
}

/** The title the 申请开票 form preselects, or `null` — never a 404. */
export async function invoiceTitleDefault(ctx: Ctx): Promise<{ title: InvoiceTitle | null }> {
  const userId = requireUserId(ctx);
  const row = await repo.findDefaultInvoiceTitle(ctx.db, userId);
  return { title: row ? toInvoiceTitle(row) : null };
}

export async function invoiceTitleDetail(ctx: Ctx, params: { id: string }): Promise<InvoiceTitle> {
  const userId = requireUserId(ctx);
  const row = await repo.findInvoiceTitle(ctx.db, { id: fromId(params.id), userId });
  if (!row) throw new DomainError('USER_INVOICE_TITLE_NOT_FOUND');
  return toInvoiceTitle(row);
}

export async function invoiceTitleCreate(ctx: Ctx, body: InvoiceTitleForm): Promise<InvoiceTitle> {
  const userId = requireUserId(ctx);
  const values = titleValues(body);
  await screenTitleName(ctx, userId, values.name, null);
  return ctx.withTx(async (tx) => {
    await repo.lockInvoiceTitleBook(tx, userId);
    const existing = await repo.countInvoiceTitles(tx, userId);
    if (existing >= INVOICE_TITLE_LIMIT) {
      throw new DomainError('USER_INVOICE_TITLE_LIMIT_REACHED', {
        details: { limit: INVOICE_TITLE_LIMIT },
      });
    }
    const now = ctx.clock.now();
    const isDefault = shouldForceDefault(existing, body.isDefault);
    // Clear first: `user_invoice_profiles_default_uq` is a partial unique index.
    if (isDefault) await repo.clearDefaultInvoiceTitle(tx, { userId, now });
    const row = await repo.insertInvoiceTitle(tx, { userId, ...values, isDefault, now });
    return toInvoiceTitle(row);
  });
}

export async function invoiceTitleUpdate(
  ctx: Ctx,
  params: { id: string },
  body: InvoiceTitleForm,
): Promise<InvoiceTitle> {
  const userId = requireUserId(ctx);
  const id = fromId(params.id);
  const values = titleValues(body);
  const existing = await repo.findInvoiceTitle(ctx.db, { id, userId });
  await screenTitleName(ctx, userId, values.name, existing?.name ?? null);
  return ctx.withTx(async (tx) => {
    await repo.lockInvoiceTitleBook(tx, userId);
    const now = ctx.clock.now();
    const current = await repo.findInvoiceTitle(tx, { id, userId });
    if (!current) throw new DomainError('USER_INVOICE_TITLE_NOT_FOUND');
    // Editing the default must not quietly demote it; `isDefault: false` on a
    // form means "not asking to promote", as on the address book.
    const isDefault = body.isDefault || current.isDefault;
    if (isDefault) await repo.clearDefaultInvoiceTitle(tx, { userId, exceptId: id, now });
    const result = await repo.updateInvoiceTitle(tx, { id, userId, ...values, isDefault, now });
    if (!result.won) throw new DomainError('USER_INVOICE_TITLE_NOT_FOUND');
    const row = await repo.findInvoiceTitle(tx, { id, userId });
    if (!row) throw new DomainError('USER_INVOICE_TITLE_NOT_FOUND');
    return toInvoiceTitle(row);
  });
}

/**
 * Soft delete. Deleting the default leaves the book with no default until the
 * customer picks one — the same as the address book; promoting "the next one"
 * would be a guess about which company they invoice next.
 */
export async function invoiceTitleDelete(ctx: Ctx, params: { id: string }): Promise<void> {
  const userId = requireUserId(ctx);
  const id = fromId(params.id);
  await ctx.withTx(async (tx) => {
    await repo.lockInvoiceTitleBook(tx, userId);
    const result = await repo.softDeleteInvoiceTitle(tx, { id, userId, now: ctx.clock.now() });
    if (!result.won) throw new DomainError('USER_INVOICE_TITLE_NOT_FOUND');
  });
}

export async function invoiceTitleSetDefault(
  ctx: Ctx,
  params: { id: string },
): Promise<InvoiceTitle> {
  const userId = requireUserId(ctx);
  const id = fromId(params.id);
  return ctx.withTx(async (tx) => {
    await repo.lockInvoiceTitleBook(tx, userId);
    const now = ctx.clock.now();
    const current = await repo.findInvoiceTitle(tx, { id, userId });
    if (!current) throw new DomainError('USER_INVOICE_TITLE_NOT_FOUND');
    await repo.clearDefaultInvoiceTitle(tx, { userId, exceptId: id, now });
    const result = await repo.setDefaultInvoiceTitle(tx, { id, userId, now });
    if (!result.won) throw new DomainError('USER_INVOICE_TITLE_NOT_FOUND');
    const row = await repo.findInvoiceTitle(tx, { id, userId });
    if (!row) throw new DomainError('USER_INVOICE_TITLE_NOT_FOUND');
    return toInvoiceTitle(row);
  });
}

/** Trim, blank → `null`, then the header rules again on what will be stored. */
/**
 * 内容安全 (C09, CONTENT-003): a new or changed 抬头 name goes to WeChat's
 * `msgSecCheck` first, outside the transaction. `risky` refuses it; WeChat
 * being unreachable lets it through (fail-open): the name reaches only the
 * merchant and the tax office.
 */
async function screenTitleName(
  ctx: Ctx,
  userId: number,
  name: string,
  previous: string | null,
): Promise<void> {
  if (name === previous) return;
  const verdict = await checkText(ctx, { userId, content: name, scene: 1, what: 'invoice-title' });
  if (verdict === 'risky') throw new DomainError('USER_INVOICE_TITLE_REJECTED');
}

function titleValues(body: InvoiceTitleForm): Omit<repo.InvoiceTitleInput, 'isDefault'> {
  const values = {
    headerType: body.headerType,
    invoiceType: body.invoiceType,
    name: blankToNull(body.name),
    dutyNumber: blankToNull(body.dutyNumber),
    drawerPhone: blankToNull(body.drawerPhone),
    email: blankToNull(body.email),
    registeredTel: blankToNull(body.registeredTel),
    registeredAddress: blankToNull(body.registeredAddress),
    bankName: blankToNull(body.bankName),
    bankAccount: blankToNull(body.bankAccount),
  };
  const problems = invoiceTitleProblems(values);
  if (problems.length > 0 || values.name === null) {
    throw new DomainError('VALIDATION_FAILED', { details: problems });
  }
  return { ...values, name: values.name };
}

function toInvoiceTitle(row: repo.InvoiceTitleRow): InvoiceTitle {
  return {
    id: toId(row.id),
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
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
