import { defineRoute } from '../_conventions/route';
import {
  appAppearanceDefaults,
  appDisplayDefaults,
  appPublicConfig,
  appPublicConfigExample,
} from './app.schemas';

/**
 * `GET /api/v1/app/config` — the mini-program's launch payload.
 *
 * **Public**: the app reads it before anybody signs in, to paint the theme and
 * the tab bar, decide which sign-in buttons to show and whether a splash comes
 * first.
 *
 * **Cheap to poll**: cached 60 s in Redis, dropped the moment a source group
 * is saved, and `version` is the weak `ETag`, so a launch that already holds
 * the current payload gets a bodyless 304 for `If-None-Match`.
 *
 * **`serverTime` is outside the `ETag`.** It is stamped per request after the
 * cache, so it never moves `version` and a caller holding the current version
 * still gets its 304. Every answer, 304 included, also carries the same
 * instant in the `X-Server-Time` response header (ISO-8601), since a 304 has
 * no body to read it from.
 */
export const systemAppConfigGet = defineRoute({
  id: 'system.appConfigGet',
  method: 'GET',
  path: '/api/v1/app/config',
  auth: 'public',
  summary: '小程序启动配置',
  tags: ['system'],
  response: appPublicConfig,
  examples: [
    { name: 'ok', response: appPublicConfigExample },
    {
      name: 'nothing-filled-in',
      // A fresh install: every field renderable, the appearance at its defaults.
      response: {
        name: 'X-ZOO商城',
        logo: { main: null, login: null, square: null, favicon: null },
        share: { title: '', synopsis: '', image: null },
        support: { kind: 'none', phone: null, qrcodeUrl: null },
        auth: { wechatOa: false, wechatMini: false, phone: false, wechatRequiresPhone: true },
        payments: { wechat: false },
        splashAd: { enabled: false, imageUrl: null, link: null, seconds: 3 },
        subscribeTemplates: {
          orderCreate: [],
          orderPay: [],
          orderUnpaid: [],
          orderShip: [],
          refund: [],
        },
        subscribeScenes: {
          checkout: [],
          groupbuyCheckout: [],
          presaleCheckout: [],
          refundApply: [],
          returnShipment: [],
        },
        webviewDomains: [],
        appearance: appAppearanceDefaults,
        display: appDisplayDefaults,
        version: '0',
        serverTime: '2026-09-24T08:00:00.000+08:00',
      },
    },
  ],
});
