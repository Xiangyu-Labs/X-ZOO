import { create } from 'zustand';
import type { InputOf, ResponseOf, RouteId } from '@shop/api-client';
import type { ChosenInvoiceTitle } from '@/platform';

/**
 * 发票抬头 form logic (pages.md §2.6). The rules are the contract's `withInvoiceHeaderRules`
 * (a 企业 title needs a 税号, a 专票 needs the four registration and bank fields), written again
 * here because `@shop/contracts` is type-only in the mini-program bundle.
 */

/**
 * Reads a 发票抬头 change makes stale (added, edited, deleted, made the default): the list, the
 * default 申请开票 starts from, and the title's edit form. The same on 发票 and the edit page.
 */
export const INVOICE_TITLE_READS: readonly RouteId[] = [
  'user.invoiceTitleList',
  'user.invoiceTitleDefault',
  'user.invoiceTitleDetail',
];

export type InvoiceTitle = ResponseOf<'user.invoiceTitleList'>['items'][number];
export type OrderInvoice = ResponseOf<'order.myInvoices'>['items'][number];
export type InvoiceTitleBody = InputOf<'user.invoiceTitleCreate'>['body'];
export type InvoiceRequestBody = InputOf<'order.invoiceRequest'>['body'];
type HeaderBody = Omit<InvoiceTitleBody, 'isDefault'>;

export interface InvoiceDraft {
  headerType: 'personal' | 'company';
  invoiceType: 'plain' | 'special';
  name: string;
  dutyNumber: string;
  drawerPhone: string;
  email: string;
  registeredAddress: string;
  registeredTel: string;
  bankName: string;
  bankAccount: string;
  isDefault: boolean;
}

export const EMPTY_INVOICE_DRAFT: InvoiceDraft = {
  headerType: 'company',
  invoiceType: 'plain',
  name: '',
  dutyNumber: '',
  drawerPhone: '',
  email: '',
  registeredAddress: '',
  registeredTel: '',
  bankName: '',
  bankAccount: '',
  isDefault: false,
};

/** The text fields, in the order the form shows them (for focusing the first error). */
export const INVOICE_FIELDS = [
  'name',
  'dutyNumber',
  'registeredAddress',
  'registeredTel',
  'bankName',
  'bankAccount',
  'drawerPhone',
  'email',
] as const;
export type InvoiceField = (typeof INVOICE_FIELDS)[number];
export type InvoiceErrors = { [K in InvoiceField]?: string | undefined };

const SPECIAL_FIELDS = ['registeredAddress', 'registeredTel', 'bankName', 'bankAccount'] as const;
const SPECIAL_LABELS: Record<(typeof SPECIAL_FIELDS)[number], string> = {
  registeredAddress: '请填写注册地址',
  registeredTel: '请填写注册电话',
  bankName: '请填写开户银行',
  bankAccount: '请填写银行账号',
};

export const HEADER_TYPE_TEXT = { personal: '个人', company: '企业' } as const;
export const INVOICE_TYPE_TEXT = { plain: '普通发票', special: '增值税专用发票' } as const;

/** A 开票记录's state, as the shopper reads it. */
export const INVOICE_STATUS_TEXT: Readonly<
  Record<OrderInvoice['status'], { text: string; tone: 'primary' | 'success' | 'neutral' }>
> = {
  requested: { text: '待开票', tone: 'primary' },
  issued: { text: '已开票', tone: 'success' },
  rejected: { text: '未通过', tone: 'neutral' },
  cancelled: { text: '已撤回', tone: 'neutral' },
};

/**
 * The state to show: an issued invoice the shop voided (冲红) is `cancelled` with `voided` set,
 * and reads 已作废 rather than 已撤回 — the shopper did not withdraw it.
 */
export function invoiceStateOf(invoice: Pick<OrderInvoice, 'status' | 'voided'>): {
  text: string;
  tone: 'primary' | 'success' | 'neutral';
} {
  return invoice.voided ? { text: '已作废', tone: 'neutral' } : INVOICE_STATUS_TEXT[invoice.status];
}

/** A 专票 is for a company only: a personal title is always 普通发票. */
export function effectiveInvoiceType(draft: InvoiceDraft): InvoiceDraft['invoiceType'] {
  return draft.headerType === 'company' ? draft.invoiceType : 'plain';
}

export function checkInvoiceDraft(draft: InvoiceDraft): InvoiceErrors {
  const errors: InvoiceErrors = {};
  if (!draft.name.trim()) {
    errors.name = draft.headerType === 'company' ? '请填写单位名称' : '请填写抬头名称';
  }
  if (draft.headerType === 'company' && !draft.dutyNumber.trim()) {
    errors.dutyNumber = '企业抬头需要填写税号';
  }
  if (effectiveInvoiceType(draft) === 'special') {
    for (const field of SPECIAL_FIELDS) {
      if (!draft[field].trim()) errors[field] = SPECIAL_LABELS[field];
    }
  }
  const phone = draft.drawerPhone.trim();
  if (phone && !/^1\d{10}$/.test(phone)) errors.drawerPhone = '请填写正确的手机号';
  const email = draft.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = '请填写正确的邮箱';
  return errors;
}

/**
 * The header fields to send: trimmed, empty ones left out, and only the fields the title's kind
 * uses (a personal title sends no 税号, a 普票 no bank details).
 */
export function invoiceHeaderBody(draft: InvoiceDraft): HeaderBody {
  const invoiceType = effectiveInvoiceType(draft);
  const body: HeaderBody = {
    headerType: draft.headerType,
    invoiceType,
    name: draft.name.trim(),
  };
  const put = (field: Exclude<InvoiceField, 'name'>) => {
    const value = draft[field].trim();
    if (value) body[field] = value;
  };
  put('drawerPhone');
  put('email');
  if (draft.headerType === 'company') put('dutyNumber');
  if (invoiceType === 'special') SPECIAL_FIELDS.forEach(put);
  return body;
}

export function invoiceTitleBody(draft: InvoiceDraft): InvoiceTitleBody {
  return { ...invoiceHeaderBody(draft), isDefault: draft.isDefault };
}

export function draftFromTitle(title: InvoiceTitle): InvoiceDraft {
  return {
    headerType: title.headerType,
    invoiceType: title.invoiceType,
    name: title.name,
    dutyNumber: title.dutyNumber ?? '',
    drawerPhone: title.drawerPhone ?? '',
    email: title.email ?? '',
    registeredAddress: title.registeredAddress ?? '',
    registeredTel: title.registeredTel ?? '',
    bankName: title.bankName ?? '',
    bankAccount: title.bankAccount ?? '',
    isDefault: title.isDefault,
  };
}

/**
 * A title imported from WeChat (`chooseInvoiceTitle`) over what the form has: the WeChat
 * fields replace theirs, the rest (收票手机, 邮箱, 默认, 发票类型) stay.
 */
export function draftFromChosen(draft: InvoiceDraft, chosen: ChosenInvoiceTitle): InvoiceDraft {
  return {
    ...draft,
    headerType: chosen.headerType,
    name: chosen.name,
    dutyNumber: chosen.dutyNumber ?? '',
    registeredAddress: chosen.registeredAddress ?? '',
    registeredTel: chosen.registeredTel ?? '',
    bankName: chosen.bankName ?? '',
    bankAccount: chosen.bankAccount ?? '',
  };
}

/**
 * The 申请开票 body a saved title prefills: every non-empty header field, nothing else (the
 * contract's `invoiceRequestFromTitle`). The caller adds a `remark`.
 */
export function invoiceRequestFromTitle(title: InvoiceTitle): InvoiceRequestBody {
  const body: InvoiceRequestBody = {
    headerType: title.headerType,
    invoiceType: title.invoiceType,
    name: title.name,
  };
  const fields = [
    'dutyNumber',
    'drawerPhone',
    'email',
    'registeredTel',
    'registeredAddress',
    'bankName',
    'bankAccount',
  ] as const;
  for (const field of fields) {
    const value = title[field];
    if (value !== null && value !== '') body[field] = value;
  }
  return body;
}

/** One line under a title's name: 税号, or what kind of title it is. */
export function titleSummary(title: InvoiceTitle): string {
  const kind = `${HEADER_TYPE_TEXT[title.headerType]} · ${INVOICE_TYPE_TEXT[title.invoiceType]}`;
  return title.dutyNumber ? `${kind} · 税号 ${title.dutyNumber}` : kind;
}

/** What the order was for: its first line, 「等 N 件」; the order number if it has none. */
export function orderSummaryText(invoice: OrderInvoice): string {
  const summary = invoice.orderSummary;
  if (!summary) return `订单 ${invoice.orderNo}`;
  return summary.lineCount > 1
    ? `${summary.productName} 等 ${summary.totalQuantity} 件`
    : summary.productName;
}

interface CreatedInvoiceTitle {
  id: string | null;
}

/**
 * The title just saved from 申请开票's 「新增抬头」, so that page picks it when it shows again.
 */
export const useCreatedInvoiceTitle = create<CreatedInvoiceTitle>()(() => ({ id: null }));
