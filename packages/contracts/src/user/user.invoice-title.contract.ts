import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  invoiceTitle,
  invoiceTitleExample,
  invoiceTitleForm,
  invoiceTitleListQuery,
  invoiceTitleSpecialExample,
  pagedInvoiceTitles,
} from './schemas';

/**
 * The shopper's 发票抬头 book: `/api/v1/invoice-titles`.
 *
 * Shaped like the address book next door, for the same reason: no route takes
 * a user id, so "user A reads user B's bank account" is unrepresentable, and
 * a title that is not the caller's answers exactly like one that does not
 * exist (`USER_INVOICE_TITLE_NOT_FOUND`).
 *
 * **Prefilling an invoice request is a copy, not a reference.** The client
 * reads a title (or `GET /invoice-titles/default`) and sends its fields to
 * `POST /api/v1/orders/:id/invoice` — `invoiceRequestFromTitle` in
 * `user/schemas.ts` does it. The order domain never reads this table: the
 * request freezes the header onto `order_invoices` either way, and a
 * `titleId` on the request would only add a cross-domain read and a second
 * way to say the same thing. Both schemas share `invoiceHeaderInput` and its
 * rules, so a title the book accepted is always a body the request accepts
 * (USER-017).
 *
 * At most `INVOICE_TITLE_LIMIT` (20) live titles per customer, and at most one
 * default — both hold under concurrent writes (USER-016).
 */

export const invoiceTitleList = defineRoute({
  id: 'user.invoiceTitleList',
  method: 'GET',
  path: '/api/v1/invoice-titles',
  auth: 'user',
  summary: '我的发票抬头',
  tags: ['user'],
  query: invoiceTitleListQuery,
  response: pagedInvoiceTitles,
  examples: [
    {
      name: 'ok',
      query: { page: 1, pageSize: 20 },
      response: {
        items: [invoiceTitleExample, invoiceTitleSpecialExample],
        total: 2,
        page: 1,
        pageSize: 20,
      },
    },
  ],
});

/**
 * The title the 申请开票 form preselects, or `null`. A customer who has never
 * saved one is an ordinary state, not an error.
 */
export const invoiceTitleDefault = defineRoute({
  id: 'user.invoiceTitleDefault',
  method: 'GET',
  path: '/api/v1/invoice-titles/default',
  auth: 'user',
  summary: '默认发票抬头',
  tags: ['user'],
  response: z.object({ title: invoiceTitle.nullable() }),
  examples: [
    { name: 'has-one', response: { title: invoiceTitleExample } },
    { name: 'none', response: { title: null } },
  ],
});

export const invoiceTitleDetail = defineRoute({
  id: 'user.invoiceTitleDetail',
  method: 'GET',
  path: '/api/v1/invoice-titles/:id',
  auth: 'user',
  summary: '发票抬头详情',
  tags: ['user'],
  params: z.object({ id }),
  response: invoiceTitle,
  errors: ['USER_INVOICE_TITLE_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '7001' }, response: invoiceTitleExample }],
});

export const invoiceTitleCreate = defineRoute({
  id: 'user.invoiceTitleCreate',
  method: 'POST',
  path: '/api/v1/invoice-titles',
  auth: 'user',
  summary: '新增发票抬头',
  tags: ['user'],
  body: invoiceTitleForm,
  response: invoiceTitle,
  status: 201,
  errors: ['USER_INVOICE_TITLE_LIMIT_REACHED', 'USER_INVOICE_TITLE_REJECTED'],
  examples: [
    {
      name: 'company-plain',
      body: {
        headerType: 'company',
        invoiceType: 'plain',
        name: '杭州某某科技有限公司',
        dutyNumber: '91330100MA2XXXXX0A',
        drawerPhone: '13800138000',
        email: 'finance@example.com',
        isDefault: true,
      },
      response: invoiceTitleExample,
    },
    {
      name: 'company-special',
      body: {
        headerType: 'company',
        invoiceType: 'special',
        name: '杭州某某科技有限公司',
        dutyNumber: '91330100MA2XXXXX0A',
        drawerPhone: '13800138000',
        email: 'finance@example.com',
        registeredTel: '0571-88888888',
        registeredAddress: '杭州市西湖区文三路 100 号',
        bankName: '中国工商银行杭州分行',
        bankAccount: '1202020209000000000',
      },
      response: invoiceTitleSpecialExample,
    },
    {
      name: 'personal',
      body: { headerType: 'personal', name: '张三' },
      response: {
        ...invoiceTitleExample,
        id: '7003',
        headerType: 'personal',
        name: '张三',
        dutyNumber: null,
        drawerPhone: null,
        email: null,
        isDefault: false,
      },
    },
  ],
});

export const invoiceTitleUpdate = defineRoute({
  id: 'user.invoiceTitleUpdate',
  method: 'PUT',
  path: '/api/v1/invoice-titles/:id',
  auth: 'user',
  summary: '编辑发票抬头',
  tags: ['user'],
  params: z.object({ id }),
  body: invoiceTitleForm,
  response: invoiceTitle,
  errors: ['USER_INVOICE_TITLE_NOT_FOUND', 'USER_INVOICE_TITLE_REJECTED'],
  examples: [
    {
      name: 'ok',
      params: { id: '7001' },
      body: {
        headerType: 'company',
        invoiceType: 'plain',
        name: '杭州某某科技有限公司',
        dutyNumber: '91330100MA2XXXXX0A',
        email: 'invoice@example.com',
      },
      response: { ...invoiceTitleExample, drawerPhone: null, email: 'invoice@example.com' },
    },
  ],
});

export const invoiceTitleDelete = defineRoute({
  id: 'user.invoiceTitleDelete',
  method: 'DELETE',
  path: '/api/v1/invoice-titles/:id',
  auth: 'user',
  summary: '删除发票抬头',
  tags: ['user'],
  params: z.object({ id }),
  response: z.void(),
  status: 204,
  errors: ['USER_INVOICE_TITLE_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '7001' }, response: undefined }],
});

/**
 * Make this one the default. A POSTed sub-resource for the same reason as
 * `POST /addresses/:id/default`: the write clears the old default and sets the
 * new one in one transaction under `user_invoice_profiles_default_uq`.
 */
export const invoiceTitleSetDefault = defineRoute({
  id: 'user.invoiceTitleSetDefault',
  method: 'POST',
  path: '/api/v1/invoice-titles/:id/default',
  auth: 'user',
  summary: '设为默认发票抬头',
  tags: ['user'],
  params: z.object({ id }),
  body: z.object({}).default({}),
  response: invoiceTitle,
  errors: ['USER_INVOICE_TITLE_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '7001' }, body: {}, response: invoiceTitleExample }],
});
