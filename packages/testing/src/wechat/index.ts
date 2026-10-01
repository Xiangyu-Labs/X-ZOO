/**
 * `@shop/testing/wechat` — the two fake WeChat servers.
 *
 * | Fake | Speaks | Used by |
 * | --- | --- | --- |
 * | `startFakeWechatGateway()` (`fake-gateway.ts`) | WeChat **Pay** v3 on `api.mch.weixin.qq.com` | payment, refund |
 * | `startFakeOaServer()` (`fake-oa-server.ts`) | `api.weixin.qq.com` — `cgi-bin`, `sns`, `wxa` | wechat-oa, storefront sign-in, mini-program codes, notification channels |
 *
 * They are separate because the two APIs share nothing but a company: different
 * host, different authentication, different body format. Both live here so
 * that more than one domain can use them without importing a test helper
 * across a domain boundary.
 */
export * from './fake-gateway';
export * from './fake-oa-server';
export * from './mini-push';
