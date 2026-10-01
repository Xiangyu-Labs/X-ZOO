import { z } from 'zod';
import { id, pageQuery } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  groupbuyCardExample,
  groupbuyDetail,
  groupbuyDetailExample,
  groupbuyGroupView,
  groupbuyGroupViewExample,
  groupbuyListQuery,
  groupbuyOpenGroupExample,
  groupbuyPoster,
  groupbuyPosterExample,
  groupbuySummary,
  groupbuySummaryExample,
  myGroupbuyItemExample,
  myGroupbuyListQuery,
  pagedGroupbuyCards,
  pagedGroupbuyOpenGroups,
  pagedMyGroupbuy,
} from './schemas';

/**
 * Storefront group-buy routes, all under `/api/v1/groupbuy/`.
 *
 * There is **no join endpoint**: joining a group is placing an order, so it
 * goes through checkout's `POST /api/v1/orders` with `kind: 'groupbuy'` and
 * `kindMeta: { activityId, groupId? }` — `groupId` absent opens a new team. A
 * second checkout path would be a second copy of stock, coupons, freight and
 * idempotency; the `OrderKindHandler` seam exists exactly so there is one.
 *
 * `POST /api/v1/groupbuy/groups/:id/withdrawal` is the leader abandoning a team
 * nobody has paid into.
 */

const groupParams = z.object({ id });
const activityParams = z.object({ id });

export const groupbuyList = defineRoute({
  id: 'groupbuy.list',
  method: 'GET',
  path: '/api/v1/groupbuy/activities',
  auth: 'public',
  summary: '拼团活动列表',
  tags: ['groupbuy'],
  query: groupbuyListQuery,
  response: pagedGroupbuyCards,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: { items: [groupbuyCardExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      // 商品详情: is this product in a live activity?
      name: 'for-a-product',
      query: { page: 1, pageSize: 1, productId: '11' },
      response: { items: [groupbuyCardExample], total: 1, page: 1, pageSize: 1 },
    },
    {
      // A DIY 拼团 component's 指定数据: 9 has ended, so it is skipped.
      name: 'picked',
      query: { page: 1, pageSize: 20, ids: '9,1' },
      response: { items: [groupbuyCardExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

/**
 * 人气条. Public, because it is the first thing on the 拼团 tab and a
 * signed-out visitor is exactly who the social proof is for.
 *
 * Cached for 60 s in Redis. The number is social proof, not an invoice: a
 * minute of lag is invisible to a shopper and the difference between one
 * aggregate a minute and one per tab open on a busy sale.
 */
export const groupbuySummaryRoute = defineRoute({
  id: 'groupbuy.summary',
  method: 'GET',
  path: '/api/v1/groupbuy/summary',
  auth: 'public',
  summary: '拼团人气',
  tags: ['groupbuy'],
  response: groupbuySummary,
  examples: [
    { name: 'busy-shop', response: groupbuySummaryExample },
    // A shop whose first activity has just opened. Not an error, not a 404.
    { name: 'nobody-yet', response: { participants: 0, avatars: [] } },
  ],
});

export const groupbuyBanners = defineRoute({
  id: 'groupbuy.banners',
  method: 'GET',
  path: '/api/v1/groupbuy/banners',
  auth: 'public',
  summary: '拼团头图',
  tags: ['groupbuy'],
  response: z.object({
    items: z.array(z.object({ imageUrl: z.string(), link: z.string().nullable() })),
  }),
  examples: [
    {
      name: 'two-banners',
      response: {
        items: [
          { imageUrl: 'https://cdn.example.com/banner/groupbuy-1.jpg', link: null },
          {
            imageUrl: 'https://cdn.example.com/banner/groupbuy-2.jpg',
            link: '/packages/promo/groupbuy/index',
          },
        ],
      },
    },
  ],
});

export const groupbuyDetailRoute = defineRoute({
  id: 'groupbuy.detail',
  method: 'GET',
  path: '/api/v1/groupbuy/activities/:id',
  auth: 'user-optional',
  summary: '拼团活动详情',
  tags: ['groupbuy'],
  params: activityParams,
  response: groupbuyDetail,
  errors: ['GROUPBUY_ACTIVITY_NOT_FOUND'],
  examples: [
    { name: 'anonymous', params: { id: '1' }, response: groupbuyDetailExample },
    {
      name: 'already-leading-a-team',
      params: { id: '1' },
      response: { ...groupbuyDetailExample, myOpenGroupId: '501' },
    },
  ],
});

export const groupbuyOpenGroups = defineRoute({
  id: 'groupbuy.openGroups',
  method: 'GET',
  path: '/api/v1/groupbuy/activities/:id/groups',
  auth: 'public',
  summary: '可参与的团',
  tags: ['groupbuy'],
  params: activityParams,
  query: pageQuery,
  response: pagedGroupbuyOpenGroups,
  errors: ['GROUPBUY_ACTIVITY_NOT_FOUND'],
  examples: [
    {
      name: 'one-team-waiting',
      params: { id: '1' },
      query: { page: 1, pageSize: 20 },
      response: { items: [groupbuyOpenGroupExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const groupbuyGroupDetailRoute = defineRoute({
  id: 'groupbuy.groupDetail',
  method: 'GET',
  path: '/api/v1/groupbuy/groups/:id',
  auth: 'user-optional',
  summary: '拼团状态页',
  tags: ['groupbuy'],
  params: groupParams,
  response: groupbuyGroupView,
  errors: ['GROUPBUY_GROUP_NOT_FOUND'],
  examples: [
    { name: 'member-view', params: { id: '501' }, response: groupbuyGroupViewExample },
    {
      name: 'anonymous-can-join',
      params: { id: '501' },
      response: {
        ...groupbuyGroupViewExample,
        members: groupbuyGroupViewExample.members.map((member) => ({ ...member, isMe: false })),
        me: null,
        canJoin: true,
      },
    },
  ],
});

export const groupbuyWithdraw = defineRoute({
  id: 'groupbuy.withdraw',
  method: 'POST',
  path: '/api/v1/groupbuy/groups/:id/withdrawal',
  auth: 'user',
  summary: '取消我发起的团',
  tags: ['groupbuy'],
  params: groupParams,
  body: z.object({}).default({}),
  response: groupbuyGroupView,
  errors: ['GROUPBUY_GROUP_NOT_FOUND', 'GROUPBUY_GROUP_NOT_WITHDRAWABLE'],
  examples: [
    {
      name: 'nobody-had-paid',
      params: { id: '501' },
      body: {},
      response: {
        ...groupbuyGroupViewExample,
        status: 'cancelled',
        seatsTaken: 0,
        seatsLeft: 3,
        members: [],
        me: null,
        canJoin: false,
      },
    },
  ],
});

export const groupbuyMyGroups = defineRoute({
  id: 'groupbuy.myGroups',
  method: 'GET',
  path: '/api/v1/groupbuy/my-groups',
  auth: 'user',
  summary: '我的拼团',
  tags: ['groupbuy'],
  query: myGroupbuyListQuery,
  response: pagedMyGroupbuy,
  examples: [
    {
      name: 'forming',
      query: { page: 1, pageSize: 20, status: 'forming' },
      response: { items: [myGroupbuyItemExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const groupbuyPosterRoute = defineRoute({
  id: 'groupbuy.poster',
  method: 'GET',
  path: '/api/v1/groupbuy/groups/:id/poster',
  auth: 'user',
  summary: '拼团海报数据',
  tags: ['groupbuy'],
  params: groupParams,
  response: groupbuyPoster,
  errors: ['GROUPBUY_GROUP_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '501' }, response: groupbuyPosterExample }],
});
