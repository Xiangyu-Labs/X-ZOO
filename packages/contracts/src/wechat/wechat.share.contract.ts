import { defineRoute } from '../_conventions/route';
import { miniCodeResult, shareMiniCodeQuery } from './schemas';

/**
 * 小程序码 for a storefront route-catalogue key — the mini program's share
 * posters.
 *
 * The client names *what* it shares (`route` + its params); the server derives
 * the page (`storefrontRouteDef(route).path`) and the 32-byte `scene`
 * (`encodeScene`), so the code opens the page the catalogue says, and the page
 * reads its params back with `decodeScene`. Only keys the catalogue marks
 * `miniCode` are accepted.
 *
 * A code is generated once per `(page, scene)` and cached in
 * `wechat_mini_codes`; each account may mint 30 **new** codes an hour; and the
 * route is `auth: 'user'` because every call may cost a WeChat request. (The
 * old uni-app's `GET /api/v1/wechat/mini-qrcodes`, which took a raw page from
 * an allow-list, was deleted at the cutover.)
 */
export const shareMiniCode = defineRoute({
  id: 'wechat.shareMiniCode',
  method: 'GET',
  path: '/api/v1/share/mini-codes',
  auth: 'user',
  summary: '获取商城页面的小程序码',
  tags: ['wechat'],
  query: shareMiniCodeQuery,
  response: miniCodeResult,
  errors: ['AUTH_WECHAT_NOT_CONFIGURED', 'WECHAT_MINI_CODE_FAILED', 'RATE_LIMITED'],
  examples: [
    {
      name: 'product',
      query: { route: 'product', id: '1024' },
      response: { url: '/uploads/wechat-mini-code/2026/09/4f1c8a2d7e6b5039.png' },
    },
    {
      name: 'groupbuy-team',
      query: { route: 'groupbuyTeam', id: '501' },
      response: { url: '/uploads/wechat-mini-code/2026/09/9b3e5d7a1c8f2604.png' },
    },
    {
      name: 'home',
      query: { route: 'home' },
      response: { url: '/uploads/wechat-mini-code/2026/09/0d2c6e4b8a1f3957.png' },
    },
  ],
});
