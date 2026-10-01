import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import { orderRefParams } from './order.ref.schemas';
import {
  adminInvoiceListQuery,
  invoiceIssueBody,
  invoiceRejectBody,
  invoiceRequestBody,
  myInvoiceListQuery,
  orderInvoice,
  orderInvoiceExample,
  pagedInvoices,
} from './order.fulfil.schemas';

/**
 * Invoices — manual only.
 *
 * The buyer asks, an operator issues the invoice **outside** the system and
 * records the number, or rejects with a reason. There is no e-invoice provider
 * and no red-ink reversal here — staff 冲红 in the tax system and then mark the
 * invoice 已作废 — so the status set is the four values `order_invoices_status`
 * actually has.
 *
 * `order_invoices_open_uq` allows exactly one `requested`-or-`issued` row per
 * order, which is why `invoiceRequest` can be a plain insert and learn "already
 * asked" from the unique violation rather than from a prior SELECT.
 *
 * The header fields are frozen onto the request at the moment it is made. The
 * shopper's saved 发票抬头 (`/api/v1/invoice-titles`, user domain) only
 * prefill the form: the client copies a title's fields into this body, and
 * editing the title afterwards never touches an invoice already asked for.
 */

export const invoiceRequest = defineRoute({
  id: 'order.invoiceRequest',
  method: 'POST',
  path: '/api/v1/orders/:id/invoice',
  auth: 'user',
  summary: '申请开票',
  tags: ['order'],
  params: orderRefParams,
  body: invoiceRequestBody,
  response: orderInvoice,
  status: 201,
  errors: [
    'ORDER_NOT_FOUND',
    'ORDER_INVOICE_ALREADY_OPEN',
    'ORDER_INVOICE_NOT_REQUESTABLE',
    'ORDER_INVOICE_TITLE_REJECTED',
  ],
  examples: [
    {
      name: 'company-plain',
      params: { id: '9001' },
      body: {
        headerType: 'company',
        invoiceType: 'plain',
        name: '杭州某某科技有限公司',
        dutyNumber: '91330100MA2XXXXX0A',
        drawerPhone: '13800138000',
        email: 'finance@example.com',
      },
      response: orderInvoiceExample,
    },
    {
      name: 'personal',
      params: { id: '9001' },
      body: { headerType: 'personal', invoiceType: 'plain', name: '张三' },
      response: {
        ...orderInvoiceExample,
        id: '3002',
        headerType: 'personal',
        name: '张三',
        dutyNumber: null,
        drawerPhone: null,
        email: null,
      },
    },
  ],
});

export const invoiceMyList = defineRoute({
  id: 'order.myInvoices',
  method: 'GET',
  path: '/api/v1/invoices',
  auth: 'user',
  summary: '我的发票申请',
  tags: ['order'],
  query: myInvoiceListQuery,
  response: pagedInvoices,
  examples: [
    {
      name: 'ok',
      query: { page: 1, pageSize: 20 },
      response: { items: [orderInvoiceExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const invoiceMyDetail = defineRoute({
  id: 'order.myInvoiceDetail',
  method: 'GET',
  path: '/api/v1/invoices/:id',
  auth: 'user',
  summary: '发票申请详情',
  tags: ['order'],
  params: z.object({ id }),
  response: orderInvoice,
  errors: ['ORDER_INVOICE_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '3001' }, response: orderInvoiceExample }],
});

/** The buyer changed their mind before anyone issued anything. Frees the order to ask again. */
export const invoiceCancel = defineRoute({
  id: 'order.cancelInvoice',
  method: 'POST',
  path: '/api/v1/invoices/:id/cancel',
  auth: 'user',
  summary: '取消开票申请',
  tags: ['order'],
  params: z.object({ id }),
  body: z.object({}).default({}),
  response: orderInvoice,
  errors: ['ORDER_INVOICE_NOT_FOUND', 'ORDER_INVOICE_NOT_ACTIONABLE'],
  examples: [
    {
      name: 'ok',
      params: { id: '3001' },
      body: {},
      response: { ...orderInvoiceExample, status: 'cancelled' },
    },
  ],
});

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

export const invoiceAdminList = defineRoute({
  id: 'order.adminInvoiceList',
  method: 'GET',
  path: '/admin-api/order-invoices',
  auth: 'admin',
  permission: 'order:invoice:read',
  summary: '发票申请列表',
  tags: ['order'],
  query: adminInvoiceListQuery,
  response: pagedInvoices,
  examples: [
    {
      name: 'pending',
      query: { page: 1, pageSize: 20, status: 'requested' },
      response: { items: [orderInvoiceExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const invoiceAdminDetail = defineRoute({
  id: 'order.adminInvoiceDetail',
  method: 'GET',
  path: '/admin-api/order-invoices/:id',
  auth: 'admin',
  permission: 'order:invoice:read',
  summary: '发票申请详情',
  tags: ['order'],
  params: z.object({ id }),
  response: orderInvoice,
  errors: ['ORDER_INVOICE_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '3001' }, response: orderInvoiceExample }],
});

export const invoiceAdminIssue = defineRoute({
  id: 'order.adminIssueInvoice',
  method: 'POST',
  path: '/admin-api/order-invoices/:id/issue',
  auth: 'admin',
  permission: 'order:invoice:write',
  summary: '标记已开票',
  tags: ['order'],
  params: z.object({ id }),
  body: invoiceIssueBody,
  response: orderInvoice,
  errors: ['ORDER_INVOICE_NOT_FOUND', 'ORDER_INVOICE_NOT_ACTIONABLE'],
  examples: [
    {
      name: 'ok',
      params: { id: '3001' },
      body: { invoiceNumber: '04400021130', remark: '已邮寄' },
      response: {
        ...orderInvoiceExample,
        status: 'issued',
        invoiceNumber: '04400021130',
        remark: '已邮寄',
        issuedAt: '2026-02-04T11:00:00+08:00',
      },
    },
  ],
});

export const invoiceAdminReject = defineRoute({
  id: 'order.adminRejectInvoice',
  method: 'POST',
  path: '/admin-api/order-invoices/:id/reject',
  auth: 'admin',
  permission: 'order:invoice:write',
  summary: '驳回开票申请',
  tags: ['order'],
  params: z.object({ id }),
  body: invoiceRejectBody,
  response: orderInvoice,
  errors: ['ORDER_INVOICE_NOT_FOUND', 'ORDER_INVOICE_NOT_ACTIONABLE'],
  examples: [
    {
      name: 'ok',
      params: { id: '3001' },
      body: { reason: '税号与抬头不匹配，请重新提交' },
      response: {
        ...orderInvoiceExample,
        status: 'rejected',
        remark: '税号与抬头不匹配，请重新提交',
      },
    },
  ],
});

/**
 * 作废 an issued invoice, by hand, once staff have reversed it (冲红) in the tax
 * system — this only records that. The row becomes `cancelled` keeping its
 * number (`voided: true`), which frees the order to ask for a new invoice. The
 * admin offers it most loudly when the order has been refunded in full
 * (`orderRefundedInFull`), but a wrong header is a reason too.
 */
export const invoiceAdminVoid = defineRoute({
  id: 'order.adminVoidInvoice',
  method: 'POST',
  path: '/admin-api/order-invoices/:id/void',
  auth: 'admin',
  permission: 'order:invoice:write',
  summary: '作废已开发票',
  tags: ['order'],
  params: z.object({ id }),
  response: orderInvoice,
  errors: ['ORDER_INVOICE_NOT_FOUND', 'ORDER_INVOICE_NOT_ACTIONABLE'],
  examples: [
    {
      name: 'ok',
      params: { id: '3001' },
      response: {
        ...orderInvoiceExample,
        status: 'cancelled',
        invoiceNumber: '24332000000012345678',
        orderRefundedInFull: true,
        voided: true,
      },
    },
  ],
});
