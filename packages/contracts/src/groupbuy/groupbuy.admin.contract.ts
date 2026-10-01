import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  groupbuyActivityDetail,
  groupbuyActivityDetailExample,
  groupbuyActivityExample,
  groupbuyActivityForm,
  groupbuyActivityListQuery,
  groupbuyActivityOrderExample,
  groupbuyActivityOrderQuery,
  groupbuyActivityStatExample,
  groupbuyActivityStatusBody,
  groupbuyCompleteBody,
  groupbuyGroupDetail,
  groupbuyGroupDetailExample,
  groupbuyGroupExample,
  groupbuyGroupListQuery,
  pagedGroupbuyActivities,
  pagedGroupbuyActivityOrders,
  pagedGroupbuyGroups,
  pagedGroupbuyStatistics,
  groupbuyStatisticsQuery,
} from './schemas';

/**
 * Admin group-buy routes.
 *
 * Resource segments claimed: `groupbuy-activities/**` and `groupbuy-groups/**`.
 * Not `combination`: the word says nothing about what the thing is, and the URL
 * is what an operator's browser history shows.
 *
 * `POST /admin-api/groupbuy-groups/:id/completion` is 立即成团. It is a POSTed
 * sub-resource, it carries its own permission, and the operator who pressed it
 * is recorded by `ctx.audit`.
 */

const activityParams = z.object({ id });
const groupParams = z.object({ id });

export const groupbuyAdminActivityList = defineRoute({
  id: 'groupbuy.adminActivityList',
  method: 'GET',
  path: '/admin-api/groupbuy-activities',
  auth: 'admin',
  permission: 'groupbuy:activity:read',
  summary: '拼团活动列表',
  tags: ['groupbuy'],
  query: groupbuyActivityListQuery,
  response: pagedGroupbuyActivities,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: { items: [groupbuyActivityExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'empty',
      query: { page: 1, pageSize: 20, status: 'ended' },
      response: { items: [], total: 0, page: 1, pageSize: 20 },
    },
  ],
});

export const groupbuyAdminActivityDetail = defineRoute({
  id: 'groupbuy.adminActivityDetail',
  method: 'GET',
  path: '/admin-api/groupbuy-activities/:id',
  auth: 'admin',
  permission: 'groupbuy:activity:read',
  summary: '拼团活动详情',
  tags: ['groupbuy'],
  params: activityParams,
  response: groupbuyActivityDetail,
  errors: ['GROUPBUY_ACTIVITY_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '1' }, response: groupbuyActivityDetailExample }],
});

export const groupbuyAdminActivityCreate = defineRoute({
  id: 'groupbuy.adminActivityCreate',
  method: 'POST',
  path: '/admin-api/groupbuy-activities',
  auth: 'admin',
  permission: 'groupbuy:activity:write',
  summary: '新建拼团活动',
  tags: ['groupbuy'],
  body: groupbuyActivityForm,
  response: groupbuyActivityDetail,
  status: 201,
  errors: ['GROUPBUY_SKU_NOT_IN_ACTIVITY'],
  examples: [
    {
      name: 'three-seats',
      body: {
        productId: '11',
        title: '三人成团 · 坚果礼盒',
        intro: '三人成团立减 29 元',
        imageUrl: 'https://cdn.example.com/p/11.jpg',
        sliderImages: ['https://cdn.example.com/p/11-1.jpg'],
        status: 'active',
        price: '59.00',
        originalPrice: '88.00',
        cost: '31.00',
        seatsRequired: 3,
        groupTtlSeconds: 86400,
        stock: 200,
        totalQuota: 500,
        perOrderQuantity: 1,
        startAt: '2026-09-01T00:00:00+08:00',
        endAt: '2026-10-31T23:59:59+08:00',
        skus: [{ skuId: '21', price: '59.00', stock: 200, quota: 500, isEnabled: true }],
      },
      response: groupbuyActivityDetailExample,
    },
  ],
});

export const groupbuyAdminActivityUpdate = defineRoute({
  id: 'groupbuy.adminActivityUpdate',
  method: 'PUT',
  path: '/admin-api/groupbuy-activities/:id',
  auth: 'admin',
  permission: 'groupbuy:activity:write',
  summary: '编辑拼团活动',
  tags: ['groupbuy'],
  params: activityParams,
  body: groupbuyActivityForm,
  response: groupbuyActivityDetail,
  errors: [
    'GROUPBUY_ACTIVITY_NOT_FOUND',
    'GROUPBUY_SKU_NOT_IN_ACTIVITY',
    'GROUPBUY_STOCK_CHANGED',
    'GROUPBUY_ACTIVITY_ENDED',
    'GROUPBUY_ACTIVITY_SKU_IN_USE',
  ],
  examples: [
    {
      name: 'reprice',
      params: { id: '1' },
      body: {
        productId: '11',
        title: '三人成团 · 坚果礼盒',
        status: 'active',
        price: '55.00',
        seatsRequired: 3,
        groupTtlSeconds: 86400,
        stock: 200,
        perOrderQuantity: 1,
        startAt: '2026-09-01T00:00:00+08:00',
        endAt: '2026-10-31T23:59:59+08:00',
        skus: [{ skuId: '21', price: '55.00', stock: 200, isEnabled: true }],
      },
      response: {
        ...groupbuyActivityDetailExample,
        price: '55.00',
        skus: [{ ...groupbuyActivityDetailExample.skus[0]!, price: '55.00' }],
      },
    },
  ],
});

export const groupbuyAdminActivitySetStatus = defineRoute({
  id: 'groupbuy.adminActivitySetStatus',
  method: 'POST',
  path: '/admin-api/groupbuy-activities/:id/status',
  auth: 'admin',
  permission: 'groupbuy:activity:write',
  summary: '启用/暂停拼团活动',
  tags: ['groupbuy'],
  params: activityParams,
  body: groupbuyActivityStatusBody,
  response: groupbuyActivityDetail,
  errors: ['GROUPBUY_ACTIVITY_NOT_FOUND'],
  examples: [
    {
      name: 'pause',
      params: { id: '1' },
      body: { status: 'paused' },
      response: { ...groupbuyActivityDetailExample, status: 'paused' },
    },
  ],
});

export const groupbuyAdminActivityDelete = defineRoute({
  id: 'groupbuy.adminActivityDelete',
  method: 'DELETE',
  path: '/admin-api/groupbuy-activities/:id',
  auth: 'admin',
  permission: 'groupbuy:activity:delete',
  summary: '删除拼团活动',
  tags: ['groupbuy'],
  params: activityParams,
  response: z.void(),
  status: 204,
  errors: ['GROUPBUY_ACTIVITY_NOT_FOUND', 'GROUPBUY_ACTIVITY_IN_USE'],
  examples: [{ name: 'ok', params: { id: '1' }, response: undefined }],
});

export const groupbuyAdminActivityOrders = defineRoute({
  id: 'groupbuy.adminActivityOrders',
  method: 'GET',
  path: '/admin-api/groupbuy-activities/:id/orders',
  auth: 'admin',
  permission: 'groupbuy:group:read',
  summary: '拼团活动的订单',
  tags: ['groupbuy'],
  params: activityParams,
  query: groupbuyActivityOrderQuery,
  response: pagedGroupbuyActivityOrders,
  errors: ['GROUPBUY_ACTIVITY_NOT_FOUND'],
  examples: [
    {
      name: 'paid-only',
      params: { id: '1' },
      query: { page: 1, pageSize: 20, paid: 'true' },
      response: { items: [groupbuyActivityOrderExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const groupbuyAdminStatistics = defineRoute({
  id: 'groupbuy.adminStatistics',
  method: 'GET',
  path: '/admin-api/groupbuy-statistics',
  auth: 'admin',
  permission: 'groupbuy:activity:read',
  summary: '拼团统计',
  tags: ['groupbuy'],
  query: groupbuyStatisticsQuery,
  response: pagedGroupbuyStatistics,
  examples: [
    {
      name: 'all-activities',
      query: { page: 1, pageSize: 20 },
      response: { items: [groupbuyActivityStatExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const groupbuyAdminGroupList = defineRoute({
  id: 'groupbuy.adminGroupList',
  method: 'GET',
  path: '/admin-api/groupbuy-groups',
  auth: 'admin',
  permission: 'groupbuy:group:read',
  summary: '拼团列表',
  tags: ['groupbuy'],
  query: groupbuyGroupListQuery,
  response: pagedGroupbuyGroups,
  examples: [
    {
      name: 'forming',
      query: { page: 1, pageSize: 20, status: 'forming' },
      response: { items: [groupbuyGroupExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const groupbuyAdminGroupDetail = defineRoute({
  id: 'groupbuy.adminGroupDetail',
  method: 'GET',
  path: '/admin-api/groupbuy-groups/:id',
  auth: 'admin',
  permission: 'groupbuy:group:read',
  summary: '拼团详情（含成员）',
  tags: ['groupbuy'],
  params: groupParams,
  response: groupbuyGroupDetail,
  errors: ['GROUPBUY_GROUP_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '501' }, response: groupbuyGroupDetailExample }],
});

export const groupbuyAdminGroupComplete = defineRoute({
  id: 'groupbuy.adminGroupComplete',
  method: 'POST',
  path: '/admin-api/groupbuy-groups/:id/completion',
  auth: 'admin',
  permission: 'groupbuy:group:complete',
  summary: '立即成团（仅限已满员的团，不虚拟补齐）',
  tags: ['groupbuy'],
  params: groupParams,
  body: groupbuyCompleteBody,
  response: groupbuyGroupDetail,
  errors: [
    'GROUPBUY_GROUP_NOT_FOUND',
    'GROUPBUY_GROUP_NOT_COMPLETABLE',
    'GROUPBUY_VIRTUAL_FILL_DISABLED',
  ],
  examples: [
    {
      name: 'fill-the-last-seat',
      params: { id: '501' },
      body: { reason: '客服协助成团' },
      response: {
        ...groupbuyGroupDetailExample,
        seatsTaken: 3,
        status: 'succeeded',
        succeededAt: '2026-09-22T11:00:00+08:00',
        virtuallyFilled: true,
      },
    },
  ],
});
