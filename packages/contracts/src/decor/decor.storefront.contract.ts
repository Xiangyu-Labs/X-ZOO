import { z } from 'zod';

import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import { USER_CENTER_DEFAULT_DOCUMENT, USER_CENTER_DEFAULT_VERSION } from './defaults';
import { resolvedPageExample } from './examples';
import { pageResolveQuery, resolvedPage } from './schemas';

/**
 * 页面装修 v2 — what the storefront reads (plan §2.1, docs/mini/decor.md).
 *
 * One request per page: the published revision with every block's data
 * resolved on the server — products on the shelf with their stock, coupons,
 * group-buys, presales, articles. The public part is cached briefly per
 * revision; with a session the shopper's own state (coupons already claimed)
 * is added in `personal`, never cached.
 *
 * The response lists only the blocks this caller should see: hidden blocks,
 * blocks for another audience or platform (`X-Client-Platform`), and block
 * types newer than the client (`X-Client-Version`, semver) are left out, and
 * so is any block type this server does not know.
 *
 * `ETag` is weak and covers the whole body; `version` changes only on publish.
 */

export const decorPageHome = defineRoute({
  id: 'decor.pageHome',
  method: 'GET',
  path: '/api/v1/pages/home',
  auth: 'user-optional',
  summary: '商城首页',
  tags: ['decor'],
  response: resolvedPage,
  errors: ['DECOR_HOME_NOT_SET'],
  examples: [{ name: 'ok', response: resolvedPageExample }],
});

/**
 * 个人中心. Never 404s: with no designated document the built-in page
 * (`USER_CENTER_DEFAULT_DOCUMENT`) is served with `id: null`.
 */
export const decorPageUserCenter = defineRoute({
  id: 'decor.pageUserCenter',
  method: 'GET',
  path: '/api/v1/pages/user-center',
  auth: 'user-optional',
  summary: '个人中心',
  tags: ['decor'],
  response: resolvedPage,
  examples: [
    {
      name: 'built-in default',
      response: {
        id: null,
        kind: 'user_center',
        revision: null,
        preview: false,
        root: USER_CENTER_DEFAULT_DOCUMENT.root,
        blocks: USER_CENTER_DEFAULT_DOCUMENT.blocks.map((block) => ({ ...block, data: {} })),
        personal: null,
        version: USER_CENTER_DEFAULT_VERSION,
        resolvedAt: '2026-09-23T10:05:00+08:00',
      },
    },
  ],
});

/**
 * Any published document by id — a 微页面 behind a `page` link, or the home
 * page itself. With `previewToken` (from the admin) the *draft* is resolved
 * instead, uncached, whether or not it was ever published.
 */
export const decorPageResolve = defineRoute({
  id: 'decor.pageResolve',
  method: 'GET',
  path: '/api/v1/pages/:id',
  auth: 'user-optional',
  summary: '装修页面',
  tags: ['decor'],
  params: z.object({ id }),
  query: pageResolveQuery,
  response: resolvedPage,
  errors: ['DECOR_DOCUMENT_NOT_FOUND', 'DECOR_PREVIEW_TOKEN_INVALID'],
  examples: [
    { name: 'published', params: { id: '7' }, response: resolvedPageExample },
    {
      name: 'preview',
      params: { id: '7' },
      query: { previewToken: 'q7Hk2xVbN0aLr9sE4tYwUc1mZpD8fJgA3iKoT6vX5eR' },
      response: { ...resolvedPageExample, revision: null, preview: true, version: 'draft-7-13' },
    },
  ],
});
