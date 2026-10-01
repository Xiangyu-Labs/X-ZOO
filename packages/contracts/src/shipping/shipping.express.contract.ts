import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  expressCompanyForm,
  expressCompanyList,
  expressCompanyListExample,
  expressCompanyListQuery,
  expressCompanyOptionsQuery,
  expressCompanyRow,
  expressCompanyRowExample,
  expressCompanyStatusBody,
  pagedExpressCompanies,
} from './schemas';

/**
 * 快递公司.
 *
 * Two surfaces with two different jobs, which is why the same table has two
 * list routes:
 *
 * 1. **The picker** — `GET /admin-api/express-companies`: the
 *    `expressCompanyList` body, and the `order:order:read` permission, because
 *    the console's 发货 form is its caller. Enabled companies only, ordered
 *    `sortOrder DESC, id ASC`.
 *    The storefront reads the same body at `GET /api/v1/express-companies`
 *    (public reference data) for the 退货物流 form, whose legacy page had no
 *    list to pick from — searched and capped there (`expressCompanyOptionsQuery`).
 * 2. **The management screen** — `/admin-api/shipping/express-companies`, paged,
 *    including disabled rows, with its own `shipping:express:*` atoms.
 *
 * There is no bulk import from a provider: the seed covers the common carriers,
 * and a rarer one is added by hand with the tracking provider's code.
 */

const companyParams = z.object({ id });

// ---------------------------------------------------------------------------
// the picker — the path the 发货 form calls
// ---------------------------------------------------------------------------

export const expressCompanyPicker = defineRoute({
  id: 'shipping.expressCompanies',
  method: 'GET',
  path: '/admin-api/express-companies',
  auth: 'admin',
  // Deliberately an `order:` atom, not `shipping:express:read`. The caller is
  // order console's 发货 form; an operator who may ship must not need a second
  // grant to see the company list.
  permission: 'order:order:read',
  summary: '物流公司列表',
  tags: ['shipping'],
  response: expressCompanyList,
  examples: [{ name: 'ok', response: expressCompanyListExample }],
});

/**
 * The shopper's 退货物流 picker: searched on the server and capped (`expressCompanyOptionsQuery`),
 * carriers with a WeChat courier code first. Its one caller is the mini-program.
 */
export const expressCompanyOptions = defineRoute({
  id: 'shipping.expressCompanyOptions',
  method: 'GET',
  path: '/api/v1/express-companies',
  auth: 'public',
  summary: '快递公司列表（退货物流）',
  tags: ['shipping'],
  query: expressCompanyOptionsQuery,
  response: expressCompanyList,
  examples: [
    { name: 'ok', response: expressCompanyListExample },
    {
      name: 'search',
      query: { keyword: '顺丰', limit: 20 },
      response: { items: [expressCompanyListExample.items[0]!] },
    },
  ],
});

// ---------------------------------------------------------------------------
// management
// ---------------------------------------------------------------------------

export const expressCompanyAdminList = defineRoute({
  id: 'shipping.expressCompanyList',
  method: 'GET',
  path: '/admin-api/shipping/express-companies',
  auth: 'admin',
  permission: 'shipping:express:read',
  summary: '快递公司管理列表',
  tags: ['shipping'],
  query: expressCompanyListQuery,
  response: pagedExpressCompanies,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: { items: [expressCompanyRowExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'disabled-only',
      query: { page: 1, pageSize: 20, isEnabled: 'false' },
      response: { items: [], total: 0, page: 1, pageSize: 20 },
    },
  ],
});

export const expressCompanyCreate = defineRoute({
  id: 'shipping.expressCompanyCreate',
  method: 'POST',
  path: '/admin-api/shipping/express-companies',
  auth: 'admin',
  permission: 'shipping:express:write',
  summary: '新建快递公司',
  tags: ['shipping'],
  body: expressCompanyForm,
  response: expressCompanyRow,
  status: 201,
  errors: ['SHIPPING_EXPRESS_COMPANY_CODE_TAKEN'],
  examples: [
    {
      name: 'ok',
      body: { code: 'SF', name: '顺丰速运', sortOrder: 100, isEnabled: true },
      response: expressCompanyRowExample,
    },
  ],
});

export const expressCompanyUpdate = defineRoute({
  id: 'shipping.expressCompanyUpdate',
  method: 'PUT',
  path: '/admin-api/shipping/express-companies/:id',
  auth: 'admin',
  permission: 'shipping:express:write',
  summary: '编辑快递公司',
  tags: ['shipping'],
  params: companyParams,
  body: expressCompanyForm,
  response: expressCompanyRow,
  errors: ['SHIPPING_EXPRESS_COMPANY_NOT_FOUND', 'SHIPPING_EXPRESS_COMPANY_CODE_TAKEN'],
  examples: [
    {
      name: 'rename',
      params: { id: '12' },
      body: { code: 'SF', name: '顺丰速运', sortOrder: 120, isEnabled: true },
      response: { ...expressCompanyRowExample, sortOrder: 120 },
    },
  ],
});

export const expressCompanySetStatus = defineRoute({
  id: 'shipping.expressCompanySetStatus',
  method: 'POST',
  path: '/admin-api/shipping/express-companies/:id/status',
  auth: 'admin',
  permission: 'shipping:express:write',
  summary: '启用/停用快递公司',
  tags: ['shipping'],
  params: companyParams,
  body: expressCompanyStatusBody,
  response: expressCompanyRow,
  errors: ['SHIPPING_EXPRESS_COMPANY_NOT_FOUND'],
  examples: [
    {
      name: 'disable',
      params: { id: '12' },
      body: { isEnabled: false },
      response: { ...expressCompanyRowExample, isEnabled: false },
    },
  ],
});

/**
 * Hard delete, refused while a shipment or a return still points at the row —
 * the foreign keys are `restrict` / `set null` and a shipment that lost its
 * carrier name is a support ticket. 停用 is the ordinary way to retire a
 * carrier; this exists for the row somebody typed by mistake.
 */
export const expressCompanyDelete = defineRoute({
  id: 'shipping.expressCompanyDelete',
  method: 'DELETE',
  path: '/admin-api/shipping/express-companies/:id',
  auth: 'admin',
  permission: 'shipping:express:write',
  summary: '删除快递公司',
  tags: ['shipping'],
  params: companyParams,
  response: z.object({ deleted: z.literal(true) }),
  errors: ['SHIPPING_EXPRESS_COMPANY_NOT_FOUND', 'SHIPPING_EXPRESS_COMPANY_IN_USE'],
  examples: [{ name: 'ok', params: { id: '99' }, response: { deleted: true } }],
});
