import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  pagedPresaleActivities,
  pagedPresaleOrders,
  presaleActivityDetail,
  presaleActivityDetailExample,
  presaleActivityExample,
  presaleActivityForm,
  presaleActivityListQuery,
  presaleActivityStatusBody,
  presaleOrderExample,
  presaleOrderListQuery,
} from './schemas';

/**
 * Admin presale routes.
 *
 * Resource segments claimed: `presale-activities/**` and `presale-orders`. Five
 * CRUD routes plus the orders view: the whole 预售活动 screen.
 */

const activityParams = z.object({ id });

export const presaleAdminActivityList = defineRoute({
  id: 'presale.adminActivityList',
  method: 'GET',
  path: '/admin-api/presale-activities',
  auth: 'admin',
  permission: 'presale:activity:read',
  summary: '预售活动列表',
  tags: ['presale'],
  query: presaleActivityListQuery,
  response: pagedPresaleActivities,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: { items: [presaleActivityExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'empty',
      query: { page: 1, pageSize: 20, status: 'ended' },
      response: { items: [], total: 0, page: 1, pageSize: 20 },
    },
  ],
});

export const presaleAdminActivityDetail = defineRoute({
  id: 'presale.adminActivityDetail',
  method: 'GET',
  path: '/admin-api/presale-activities/:id',
  auth: 'admin',
  permission: 'presale:activity:read',
  summary: '预售活动详情',
  tags: ['presale'],
  params: activityParams,
  response: presaleActivityDetail,
  errors: ['PRESALE_ACTIVITY_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '2' }, response: presaleActivityDetailExample }],
});

export const presaleAdminActivityCreate = defineRoute({
  id: 'presale.adminActivityCreate',
  method: 'POST',
  path: '/admin-api/presale-activities',
  auth: 'admin',
  permission: 'presale:activity:write',
  summary: '新建预售活动',
  tags: ['presale'],
  body: presaleActivityForm,
  response: presaleActivityDetail,
  status: 201,
  errors: ['PRESALE_SKU_NOT_IN_ACTIVITY', 'PRESALE_DEPOSIT_NOT_SUPPORTED'],
  examples: [
    {
      name: 'full-payment',
      body: {
        productId: '12',
        title: '春茶预售 · 明前龙井',
        intro: '付款后 15 天内发货',
        imageUrl: 'https://cdn.example.com/p/12.jpg',
        sliderImages: ['https://cdn.example.com/p/12-1.jpg'],
        status: 'active',
        paymentMode: 'full',
        price: '128.00',
        originalPrice: '168.00',
        stock: 500,
        totalQuota: 1000,
        perOrderQuantity: 5,
        startAt: '2026-09-01T00:00:00+08:00',
        endAt: '2026-11-30T23:59:59+08:00',
        shipAfterDays: 15,
        skus: [{ skuId: '31', price: '128.00', stock: 500, quota: 1000, isEnabled: true }],
      },
      response: presaleActivityDetailExample,
    },
  ],
});

export const presaleAdminActivityUpdate = defineRoute({
  id: 'presale.adminActivityUpdate',
  method: 'PUT',
  path: '/admin-api/presale-activities/:id',
  auth: 'admin',
  permission: 'presale:activity:write',
  summary: '编辑预售活动',
  tags: ['presale'],
  params: activityParams,
  body: presaleActivityForm,
  response: presaleActivityDetail,
  errors: [
    'PRESALE_ACTIVITY_NOT_FOUND',
    'PRESALE_SKU_NOT_IN_ACTIVITY',
    'PRESALE_DEPOSIT_NOT_SUPPORTED',
    'PRESALE_STOCK_CHANGED',
    'PRESALE_ACTIVITY_ENDED',
    'PRESALE_ACTIVITY_SKU_IN_USE',
  ],
  examples: [
    {
      name: 'ship-sooner',
      params: { id: '2' },
      body: {
        productId: '12',
        title: '春茶预售 · 明前龙井',
        status: 'active',
        paymentMode: 'full',
        price: '128.00',
        stock: 500,
        perOrderQuantity: 5,
        startAt: '2026-09-01T00:00:00+08:00',
        endAt: '2026-11-30T23:59:59+08:00',
        shipAfterDays: 10,
        skus: [{ skuId: '31', price: '128.00', stock: 500, isEnabled: true }],
      },
      response: { ...presaleActivityDetailExample, shipAfterDays: 10 },
    },
  ],
});

export const presaleAdminActivitySetStatus = defineRoute({
  id: 'presale.adminActivitySetStatus',
  method: 'POST',
  path: '/admin-api/presale-activities/:id/status',
  auth: 'admin',
  permission: 'presale:activity:write',
  summary: '启用/暂停预售活动',
  tags: ['presale'],
  params: activityParams,
  body: presaleActivityStatusBody,
  response: presaleActivityDetail,
  errors: ['PRESALE_ACTIVITY_NOT_FOUND'],
  examples: [
    {
      name: 'pause',
      params: { id: '2' },
      body: { status: 'paused' },
      response: { ...presaleActivityDetailExample, status: 'paused' },
    },
  ],
});

export const presaleAdminActivityDelete = defineRoute({
  id: 'presale.adminActivityDelete',
  method: 'DELETE',
  path: '/admin-api/presale-activities/:id',
  auth: 'admin',
  permission: 'presale:activity:delete',
  summary: '删除预售活动',
  tags: ['presale'],
  params: activityParams,
  response: z.void(),
  status: 204,
  errors: ['PRESALE_ACTIVITY_NOT_FOUND', 'PRESALE_ACTIVITY_IN_USE'],
  examples: [{ name: 'ok', params: { id: '2' }, response: undefined }],
});

export const presaleAdminOrderList = defineRoute({
  id: 'presale.adminOrderList',
  method: 'GET',
  path: '/admin-api/presale-orders',
  auth: 'admin',
  permission: 'presale:order:read',
  summary: '预售订单',
  tags: ['presale'],
  query: presaleOrderListQuery,
  response: pagedPresaleOrders,
  examples: [
    {
      name: 'paid',
      query: { page: 1, pageSize: 20, stage: 'final_paid' },
      response: { items: [presaleOrderExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});
