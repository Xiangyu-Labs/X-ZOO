import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  pagedWechatMedia,
  wechatMediaListQuery,
  wechatMediaSyncResult,
  wechatMediaUploadBody,
  wechatMedium,
  wechatMediumExample,
} from './schemas';

/**
 * The WeChat material library, `/admin-api/wechat-media`.
 *
 * `wechat_media` is a **mapping**, not a second media library: the bytes live
 * in `attachments`, and a row here says "WeChat also holds this one, under this
 * handle". That is why the upload route takes an attachment id instead of a
 * file — see `wechatMediaUploadBody`.
 *
 * WeChat is the authority on what it still holds. A temporary asset expires
 * after three days and a permanent one can be deleted from the 公众平台 by
 * somebody who never opened this screen, so `POST …/sync` reconciles both ways
 * rather than assuming our table is right.
 */

const mediaParams = z.object({ id });

export const wechatOaMediaList = defineRoute({
  id: 'wechatOa.mediaList',
  method: 'GET',
  path: '/admin-api/wechat-media',
  auth: 'admin',
  permission: 'wechat-oa:media:read',
  summary: '微信素材列表',
  tags: ['wechat-oa'],
  query: wechatMediaListQuery,
  response: pagedWechatMedia,
  examples: [
    {
      name: 'images',
      query: { page: 1, pageSize: 20, kind: 'image' },
      response: { items: [wechatMediumExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const wechatOaMediaUpload = defineRoute({
  id: 'wechatOa.mediaUpload',
  method: 'POST',
  path: '/admin-api/wechat-media',
  auth: 'admin',
  permission: 'wechat-oa:media:write',
  summary: '把素材库文件上传到微信',
  tags: ['wechat-oa'],
  body: wechatMediaUploadBody,
  response: wechatMedium,
  status: 201,
  errors: [
    'WECHAT_OA_MEDIA_UNSUPPORTED',
    'WECHAT_OA_NOT_CONFIGURED',
    'WECHAT_OA_API_FAILED',
    'NOT_FOUND',
  ],
  examples: [
    {
      name: 'permanent-image',
      body: { attachmentId: '12', kind: 'image', isPermanent: true },
      response: wechatMediumExample,
    },
  ],
});

export const wechatOaMediaDelete = defineRoute({
  id: 'wechatOa.mediaDelete',
  method: 'DELETE',
  path: '/admin-api/wechat-media/:id',
  auth: 'admin',
  permission: 'wechat-oa:media:write',
  summary: '删除微信素材',
  tags: ['wechat-oa'],
  params: mediaParams,
  response: z.void(),
  status: 204,
  errors: ['WECHAT_OA_MEDIA_NOT_FOUND', 'WECHAT_OA_NOT_CONFIGURED'],
  examples: [{ name: 'ok', params: { id: '1' }, response: undefined }],
});

export const wechatOaMediaSync = defineRoute({
  id: 'wechatOa.mediaSync',
  method: 'POST',
  path: '/admin-api/wechat-media/sync',
  auth: 'admin',
  permission: 'wechat-oa:media:write',
  summary: '与微信素材库同步',
  tags: ['wechat-oa'],
  response: wechatMediaSyncResult,
  errors: ['WECHAT_OA_NOT_CONFIGURED', 'WECHAT_OA_API_FAILED'],
  examples: [{ name: 'ok', response: { removed: 2, added: 5, unchanged: 31 } }],
});
