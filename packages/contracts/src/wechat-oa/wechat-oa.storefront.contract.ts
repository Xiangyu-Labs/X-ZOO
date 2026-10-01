import { defineRoute } from '../_conventions/route';
import {
  jssdkConfig,
  jssdkConfigQuery,
  subscribeTemplates,
  subscribeTemplatesQuery,
} from './schemas';

/**
 * What the storefront asks the Official Account layer for.
 *
 * Both routes are `user-optional`: a visitor who has not signed in still needs
 * `wx.config` to take a photo or share a page, and the mini-program has to know
 * which subscribe templates to ask permission for before the first order
 * exists. Neither returns anything about a particular person.
 */

/**
 * `wx.config` parameters for an H5 page inside the WeChat browser.
 *
 * The ticket behind the signature is cached in Redis with the same
 * single-flight refresh the access token uses (they have the same 7200-second
 * lifetime and the same "two nodes must not both ask" problem), so a burst of
 * page loads produces one call to `cgi-bin/ticket/getticket`, not one per page.
 *
 * The signed URL must be the page's own `location.href` minus the `#` fragment,
 * and it must be on a domain the account has authorised — the service checks it
 * against the configured site URL and refuses otherwise with
 * `WECHAT_OA_URL_NOT_ALLOWED`. Signing whatever string is handed over would
 * make this a signing oracle for anybody's page.
 */
export const wechatOaJssdkConfig = defineRoute({
  id: 'wechatOa.jssdkConfig',
  method: 'GET',
  path: '/api/v1/wechat/jssdk-config',
  auth: 'user-optional',
  summary: '获取微信 JS-SDK 配置',
  tags: ['wechat-oa'],
  query: jssdkConfigQuery,
  response: jssdkConfig,
  errors: ['WECHAT_OA_NOT_CONFIGURED', 'WECHAT_OA_URL_NOT_ALLOWED', 'WECHAT_OA_API_FAILED'],
  examples: [
    {
      name: 'signed',
      query: { url: 'https://shop.example.com/pages/index/index' },
      response: {
        appId: 'wx1234567890abcdef',
        timestamp: '1767668400',
        nonceStr: 'A1b2C3d4E5f6G7h8',
        signature: '0f9de62fce790f9a083d5c99e95740ceb90c27ed',
      },
    },
  ],
});

/**
 * Which subscribe-message templates the mini-program should ask about, for one
 * moment in the journey.
 *
 * An empty array is a normal answer, not an error: a shop that has configured
 * no subscribe templates simply skips `wx.requestSubscribeMessage`. Returning
 * an error there would make every checkout show a red toast about a feature the
 * shop deliberately does not use.
 */
export const wechatOaSubscribeTemplates = defineRoute({
  id: 'wechatOa.subscribeTemplates',
  method: 'GET',
  path: '/api/v1/wechat/subscribe-templates',
  auth: 'user-optional',
  summary: '小程序订阅消息模板 ID',
  tags: ['wechat-oa'],
  query: subscribeTemplatesQuery,
  response: subscribeTemplates,
  examples: [
    {
      name: 'order-pay',
      query: { scene: 'order-pay' },
      response: {
        templateIds: [
          'ZCQ1oT0cD2mYy1Q-kLJbo2kQ3s6cxJ5Zx9pLb-7xQ1A',
          'HdLq2mW5vN8kR3pT-yUxZ6bA1cE4gJ7nM0oP9sV2iK',
        ],
      },
    },
    { name: 'not-configured', query: { scene: 'refund' }, response: { templateIds: [] } },
  ],
});
