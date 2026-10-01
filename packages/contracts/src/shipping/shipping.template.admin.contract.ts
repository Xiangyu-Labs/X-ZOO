import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  pagedShippingTemplates,
  shippingTemplateDetail,
  shippingTemplateDetailExample,
  shippingTemplateExample,
  shippingTemplateForm,
  shippingTemplateListQuery,
  shippingTemplateOptions,
  shippingTemplateTrialBody,
  shippingTemplateTrialResult,
} from './schemas';

/**
 * 运费模板, `/admin-api/shipping/templates`.
 *
 * The URL is namespaced under `shipping/` for the reason the catalog is
 * namespaced: "templates", "cities" and "regions" are words several domains
 * would like, and in the App Router the directory *is* the URL, so an
 * unqualified segment is a collision waiting to happen. The express-company
 * picker (`/admin-api/express-companies`) is the deliberate exception: the
 * order console calls it by that path.
 */

const templateParams = z.object({ id });

export const shippingTemplateList = defineRoute({
  id: 'shipping.templateList',
  method: 'GET',
  path: '/admin-api/shipping/templates',
  auth: 'admin',
  permission: 'shipping:template:read',
  summary: '运费模板列表',
  tags: ['shipping'],
  query: shippingTemplateListQuery,
  response: pagedShippingTemplates,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: { items: [shippingTemplateExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'empty',
      query: { page: 1, pageSize: 20, keyword: '空运' },
      response: { items: [], total: 0, page: 1, pageSize: 20 },
    },
  ],
});

/**
 * The 运费模板 select on the product editor.
 *
 * Its own route rather than a page of the list, because the picker wants every
 * template in one call and none of the region detail. The product editor's
 * 运费模板 select loads its options from here.
 */
export const shippingTemplateOptionList = defineRoute({
  id: 'shipping.templateOptions',
  method: 'GET',
  path: '/admin-api/shipping/template-options',
  auth: 'admin',
  permission: 'shipping:template:read',
  summary: '运费模板下拉选项',
  tags: ['shipping'],
  response: shippingTemplateOptions,
  examples: [
    {
      name: 'ok',
      response: { items: [{ id: '1', name: '全国包邮（满 5 件）', chargeMode: 'quantity' }] },
    },
  ],
});

export const shippingTemplateDetailRoute = defineRoute({
  id: 'shipping.templateDetail',
  method: 'GET',
  path: '/admin-api/shipping/templates/:id',
  auth: 'admin',
  permission: 'shipping:template:read',
  summary: '运费模板详情',
  tags: ['shipping'],
  params: templateParams,
  response: shippingTemplateDetail,
  errors: ['SHIPPING_TEMPLATE_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '1' }, response: shippingTemplateDetailExample }],
});

export const shippingTemplateCreate = defineRoute({
  id: 'shipping.templateCreate',
  method: 'POST',
  path: '/admin-api/shipping/templates',
  auth: 'admin',
  permission: 'shipping:template:write',
  summary: '新建运费模板',
  tags: ['shipping'],
  body: shippingTemplateForm,
  response: shippingTemplateDetail,
  status: 201,
  errors: ['SHIPPING_CITY_UNKNOWN', 'SHIPPING_REGION_OVERLAP'],
  examples: [
    {
      name: 'by-piece',
      body: {
        name: '全国包邮（满 5 件）',
        chargeMode: 'quantity',
        hasFreeRules: true,
        hasNoDeliveryRules: true,
        sortOrder: 10,
        regions: [
          {
            isFallback: true,
            cityIds: [],
            firstUnit: 1,
            firstPrice: '10.00',
            additionalUnit: 1,
            additionalPrice: '5.00',
          },
          {
            isFallback: false,
            cityIds: ['110100', '310100'],
            firstUnit: 2,
            firstPrice: '6.00',
            additionalUnit: 1,
            additionalPrice: '2.00',
          },
        ],
        freeRules: [{ cityIds: ['110100'], minUnits: 5, minAmount: '199.00' }],
        noDeliveryCityIds: ['820000'],
      },
      response: shippingTemplateDetailExample,
    },
    {
      name: 'by-weight-minimal',
      body: {
        name: '按重量计费',
        chargeMode: 'weight',
        regions: [
          {
            isFallback: true,
            cityIds: [],
            firstUnit: 1,
            firstPrice: '8.00',
            additionalUnit: 0.5,
            additionalPrice: '3.00',
          },
        ],
      },
      response: {
        ...shippingTemplateDetailExample,
        id: '2',
        name: '按重量计费',
        chargeMode: 'weight',
        hasFreeRules: false,
        hasNoDeliveryRules: false,
        sortOrder: 0,
        productCount: 0,
        regions: [
          {
            isFallback: true,
            cityIds: [],
            firstUnit: 1,
            firstPrice: '8.00',
            additionalUnit: 0.5,
            additionalPrice: '3.00',
          },
        ],
        freeRules: [],
        noDeliveryCityIds: [],
      },
    },
  ],
});

export const shippingTemplateUpdate = defineRoute({
  id: 'shipping.templateUpdate',
  method: 'PUT',
  path: '/admin-api/shipping/templates/:id',
  auth: 'admin',
  permission: 'shipping:template:write',
  summary: '编辑运费模板',
  tags: ['shipping'],
  params: templateParams,
  body: shippingTemplateForm,
  response: shippingTemplateDetail,
  errors: ['SHIPPING_TEMPLATE_NOT_FOUND', 'SHIPPING_CITY_UNKNOWN', 'SHIPPING_REGION_OVERLAP'],
  examples: [
    {
      name: 'rename',
      params: { id: '1' },
      body: {
        name: '全国包邮（满 5 件）',
        chargeMode: 'quantity',
        hasFreeRules: true,
        hasNoDeliveryRules: true,
        sortOrder: 10,
        regions: shippingTemplateDetailExample.regions,
        freeRules: shippingTemplateDetailExample.freeRules,
        noDeliveryCityIds: shippingTemplateDetailExample.noDeliveryCityIds,
      },
      response: shippingTemplateDetailExample,
    },
  ],
});

/**
 * Deleting is a soft delete, and it is refused while a product still points at
 * the template: the alternative is silently moving those products onto "no
 * template", which quotes zero freight and nobody notices until the month's
 * postage bill.
 */
export const shippingTemplateDelete = defineRoute({
  id: 'shipping.templateDelete',
  method: 'DELETE',
  path: '/admin-api/shipping/templates/:id',
  auth: 'admin',
  permission: 'shipping:template:delete',
  summary: '删除运费模板',
  tags: ['shipping'],
  params: templateParams,
  response: z.object({ deleted: z.literal(true) }),
  errors: ['SHIPPING_TEMPLATE_NOT_FOUND', 'SHIPPING_TEMPLATE_IN_USE'],
  examples: [{ name: 'ok', params: { id: '9' }, response: { deleted: true } }],
});

/**
 * 运费试算 — prices one product to one address against the template as the
 * drawer holds it, saved or not, and says which rule decided it. Nothing is
 * written, so reading templates is permission enough.
 */
export const shippingTemplateTrial = defineRoute({
  id: 'shipping.templateTrial',
  method: 'POST',
  path: '/admin-api/shipping/template-trial',
  auth: 'admin',
  permission: 'shipping:template:read',
  summary: '运费试算',
  tags: ['shipping'],
  body: shippingTemplateTrialBody,
  response: shippingTemplateTrialResult,
  errors: ['SHIPPING_CITY_UNKNOWN'],
  examples: [
    {
      name: 'charged',
      body: {
        template: {
          name: '全国包邮（满 5 件）',
          chargeMode: 'quantity',
          regions: shippingTemplateDetailExample.regions,
        },
        cityId: '110105',
        units: 3,
        amount: '120.00',
      },
      response: {
        outcome: 'charged',
        fee: '8.00',
        steps: [
          '收货地区：北京市 › 北京市 › 朝阳区',
          '命中第 2 条地区规则（北京市）',
          '首 2 件 ¥6.00 + 续 1 次（每 1 件 ¥2.00）= ¥8.00',
        ],
      },
    },
    {
      name: 'undeliverable',
      body: {
        template: {
          name: '全国包邮（满 5 件）',
          chargeMode: 'quantity',
          hasNoDeliveryRules: true,
          regions: shippingTemplateDetailExample.regions,
          noDeliveryCityIds: ['820000'],
        },
        cityId: '820100',
        units: 1,
        amount: '10.00',
      },
      response: {
        outcome: 'undeliverable',
        fee: '0.00',
        steps: [
          '收货地区：澳门特别行政区 › 澳门半岛',
          '「澳门特别行政区」在「不配送地区」里，下单会被拒绝',
        ],
      },
    },
  ],
});
