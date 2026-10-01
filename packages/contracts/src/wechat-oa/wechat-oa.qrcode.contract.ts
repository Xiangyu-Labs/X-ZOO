import { z } from 'zod';
import { id, pageQuery, paged } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  pagedWechatQrcodeScans,
  pagedWechatQrcodes,
  wechatQrcode,
  wechatQrcodeCategory,
  wechatQrcodeCategoryExample,
  wechatQrcodeCategoryForm,
  wechatQrcodeExample,
  wechatQrcodeForm,
  wechatQrcodeListQuery,
  wechatQrcodeStatQuery,
  wechatQrcodeStatistic,
  wechatQrcodeStatusBody,
} from './schemas';

/**
 * 渠道码 — parametric QR codes, `/admin-api/wechat-qrcodes`.
 *
 * A channel code is a poster: it carries a scene string, WeChat echoes that
 * string back on every scan, and the webhook attributes the scan (and any
 * follow that came with it) to the poster. The counters on the row are
 * maintained by conditional increments from the webhook, never by a
 * read-then-write, because two people can scan the same poster in the same
 * millisecond and the check constraint `wechat_qrcodes_counters_non_negative`
 * is not a substitute for getting that right.
 *
 * `scanCount` and `followCount` are denormalised totals for the list; the
 * statistic route re-aggregates `wechat_qrcode_scans`, which is the row-level
 * truth and the only place `uniqueScanners` can come from.
 */

const qrcodeParams = z.object({ id });

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

export const wechatOaQrcodeCategoryList = defineRoute({
  id: 'wechatOa.qrcodeCategoryList',
  method: 'GET',
  path: '/admin-api/wechat-qrcode-categories',
  auth: 'admin',
  permission: 'wechat-oa:qrcode:read',
  summary: '渠道码分类列表',
  tags: ['wechat-oa'],
  query: pageQuery,
  response: paged(wechatQrcodeCategory),
  examples: [
    {
      name: 'one',
      query: { page: 1, pageSize: 20 },
      response: { items: [wechatQrcodeCategoryExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const wechatOaQrcodeCategoryCreate = defineRoute({
  id: 'wechatOa.qrcodeCategoryCreate',
  method: 'POST',
  path: '/admin-api/wechat-qrcode-categories',
  auth: 'admin',
  permission: 'wechat-oa:qrcode:write',
  summary: '新建渠道码分类',
  tags: ['wechat-oa'],
  body: wechatQrcodeCategoryForm,
  response: wechatQrcodeCategory,
  status: 201,
  errors: ['WECHAT_OA_CATEGORY_NAME_TAKEN'],
  examples: [
    {
      name: 'ok',
      body: { name: '线下门店', sortOrder: 0 },
      response: { ...wechatQrcodeCategoryExample, qrcodeCount: 0 },
    },
  ],
});

export const wechatOaQrcodeCategoryUpdate = defineRoute({
  id: 'wechatOa.qrcodeCategoryUpdate',
  method: 'PUT',
  path: '/admin-api/wechat-qrcode-categories/:id',
  auth: 'admin',
  permission: 'wechat-oa:qrcode:write',
  summary: '编辑渠道码分类',
  tags: ['wechat-oa'],
  params: qrcodeParams,
  body: wechatQrcodeCategoryForm,
  response: wechatQrcodeCategory,
  errors: ['WECHAT_OA_CATEGORY_NOT_FOUND', 'WECHAT_OA_CATEGORY_NAME_TAKEN'],
  examples: [
    {
      name: 'rename',
      params: { id: '1' },
      body: { name: '门店海报', sortOrder: 1 },
      response: { ...wechatQrcodeCategoryExample, name: '门店海报', sortOrder: 1 },
    },
  ],
});

export const wechatOaQrcodeCategoryDelete = defineRoute({
  id: 'wechatOa.qrcodeCategoryDelete',
  method: 'DELETE',
  path: '/admin-api/wechat-qrcode-categories/:id',
  auth: 'admin',
  permission: 'wechat-oa:qrcode:write',
  summary: '删除渠道码分类',
  tags: ['wechat-oa'],
  params: qrcodeParams,
  response: z.void(),
  status: 204,
  errors: ['WECHAT_OA_CATEGORY_NOT_FOUND', 'WECHAT_OA_CATEGORY_NOT_EMPTY'],
  examples: [{ name: 'ok', params: { id: '2' }, response: undefined }],
});

// ---------------------------------------------------------------------------
// codes
// ---------------------------------------------------------------------------

export const wechatOaQrcodeList = defineRoute({
  id: 'wechatOa.qrcodeList',
  method: 'GET',
  path: '/admin-api/wechat-qrcodes',
  auth: 'admin',
  permission: 'wechat-oa:qrcode:read',
  summary: '渠道码列表',
  tags: ['wechat-oa'],
  query: wechatQrcodeListQuery,
  response: pagedWechatQrcodes,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20, sortBy: 'scanCount', sortOrder: 'desc' },
      response: { items: [wechatQrcodeExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const wechatOaQrcodeDetail = defineRoute({
  id: 'wechatOa.qrcodeDetail',
  method: 'GET',
  path: '/admin-api/wechat-qrcodes/:id',
  auth: 'admin',
  permission: 'wechat-oa:qrcode:read',
  summary: '渠道码详情',
  tags: ['wechat-oa'],
  params: qrcodeParams,
  response: wechatQrcode,
  errors: ['WECHAT_OA_QRCODE_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '1' }, response: wechatQrcodeExample }],
});

/**
 * Creating a channel code calls WeChat: the ticket and the image URL come from
 * `cgi-bin/qrcode/create` and cannot be invented locally. An unconfigured
 * account therefore refuses with `WECHAT_OA_NOT_CONFIGURED` instead of storing
 * a row with a null ticket that nobody can print.
 */
export const wechatOaQrcodeCreate = defineRoute({
  id: 'wechatOa.qrcodeCreate',
  method: 'POST',
  path: '/admin-api/wechat-qrcodes',
  auth: 'admin',
  permission: 'wechat-oa:qrcode:write',
  summary: '新建渠道码',
  tags: ['wechat-oa'],
  body: wechatQrcodeForm,
  response: wechatQrcode,
  status: 201,
  errors: [
    'WECHAT_OA_QRCODE_SCENE_TAKEN',
    'WECHAT_OA_CATEGORY_NOT_FOUND',
    'WECHAT_OA_NOT_CONFIGURED',
    'WECHAT_OA_API_FAILED',
  ],
  examples: [
    {
      name: 'permanent',
      body: {
        name: '朝阳门店海报',
        categoryId: '1',
        scene: 'CH_A1B2C3',
        expireSeconds: 0,
        replyType: 'text',
        replyPayload: { text: '欢迎关注，回复「优惠券」领取新人券' },
      },
      response: { ...wechatQrcodeExample, scanCount: 0, followCount: 0 },
    },
    {
      name: 'temporary-7-days',
      body: { name: '双11 活动码', expireSeconds: 604800 },
      response: {
        ...wechatQrcodeExample,
        id: '2',
        name: '双11 活动码',
        categoryId: null,
        categoryName: null,
        scene: 'CH_9K3M2P',
        expiresAt: '2026-01-11T10:00:00+08:00',
        replyType: null,
        replyPayload: null,
        scanCount: 0,
        followCount: 0,
      },
    },
  ],
});

/**
 * Only the label, the filing and the reply are editable.
 *
 * The scene string and the ticket are not: WeChat minted the image against that
 * scene, the poster is already printed, and re-pointing the scene would
 * silently re-attribute every future scan of a poster on a wall somewhere.
 */
export const wechatOaQrcodeUpdate = defineRoute({
  id: 'wechatOa.qrcodeUpdate',
  method: 'PUT',
  path: '/admin-api/wechat-qrcodes/:id',
  auth: 'admin',
  permission: 'wechat-oa:qrcode:write',
  summary: '编辑渠道码',
  tags: ['wechat-oa'],
  params: qrcodeParams,
  body: wechatQrcodeForm.omit({ scene: true, expireSeconds: true }),
  response: wechatQrcode,
  errors: ['WECHAT_OA_QRCODE_NOT_FOUND', 'WECHAT_OA_CATEGORY_NOT_FOUND'],
  examples: [
    {
      name: 'rename',
      params: { id: '1' },
      body: { name: '朝阳门店立牌', categoryId: '1' },
      response: { ...wechatQrcodeExample, name: '朝阳门店立牌' },
    },
  ],
});

export const wechatOaQrcodeSetStatus = defineRoute({
  id: 'wechatOa.qrcodeSetStatus',
  method: 'POST',
  path: '/admin-api/wechat-qrcodes/:id/status',
  auth: 'admin',
  permission: 'wechat-oa:qrcode:write',
  summary: '启用/停用渠道码',
  tags: ['wechat-oa'],
  params: qrcodeParams,
  body: wechatQrcodeStatusBody,
  response: wechatQrcode,
  errors: ['WECHAT_OA_QRCODE_NOT_FOUND'],
  examples: [
    {
      name: 'disable',
      params: { id: '1' },
      body: { status: 'disabled' },
      response: { ...wechatQrcodeExample, status: 'disabled' },
    },
  ],
});

export const wechatOaQrcodeDelete = defineRoute({
  id: 'wechatOa.qrcodeDelete',
  method: 'DELETE',
  path: '/admin-api/wechat-qrcodes/:id',
  auth: 'admin',
  permission: 'wechat-oa:qrcode:write',
  summary: '删除渠道码',
  tags: ['wechat-oa'],
  params: qrcodeParams,
  response: z.void(),
  status: 204,
  errors: ['WECHAT_OA_QRCODE_NOT_FOUND'],
  examples: [{ name: 'ok', params: { id: '1' }, response: undefined }],
});

export const wechatOaQrcodeStatistic = defineRoute({
  id: 'wechatOa.qrcodeStatistic',
  method: 'GET',
  path: '/admin-api/wechat-qrcodes/:id/statistic',
  auth: 'admin',
  permission: 'wechat-oa:qrcode:read',
  summary: '渠道码扫码统计',
  tags: ['wechat-oa'],
  params: qrcodeParams,
  query: wechatQrcodeStatQuery,
  response: wechatQrcodeStatistic,
  errors: ['WECHAT_OA_QRCODE_NOT_FOUND'],
  examples: [
    {
      name: 'two-days',
      params: { id: '1' },
      query: { from: '2026-01-05', to: '2026-01-06' },
      response: {
        qrcodeId: '1',
        name: '朝阳门店海报',
        scanCount: 128,
        followCount: 47,
        uniqueScanners: 96,
        points: [
          { date: '2026-01-05', scans: 51, newFollowers: 19 },
          { date: '2026-01-06', scans: 77, newFollowers: 28 },
        ],
      },
    },
  ],
});

export const wechatOaQrcodeScans = defineRoute({
  id: 'wechatOa.qrcodeScans',
  method: 'GET',
  path: '/admin-api/wechat-qrcodes/:id/scans',
  auth: 'admin',
  permission: 'wechat-oa:qrcode:read',
  summary: '渠道码扫码明细',
  tags: ['wechat-oa'],
  params: qrcodeParams,
  query: pageQuery,
  response: pagedWechatQrcodeScans,
  errors: ['WECHAT_OA_QRCODE_NOT_FOUND'],
  examples: [
    {
      name: 'first-page',
      params: { id: '1' },
      query: { page: 1, pageSize: 20 },
      response: {
        items: [
          {
            id: '3001',
            userId: '88',
            nickname: '小明',
            avatar: 'https://shop.example.com/uploads/2026/01/a.png',
            openid: 'oABC****WXYZ',
            isNewFollower: true,
            createdAt: '2026-01-06T09:12:00+08:00',
          },
          {
            id: '3000',
            userId: null,
            nickname: null,
            avatar: null,
            openid: 'oQRS****1234',
            isNewFollower: false,
            createdAt: '2026-01-06T09:10:00+08:00',
          },
        ],
        total: 2,
        page: 1,
        pageSize: 20,
      },
    },
  ],
});
