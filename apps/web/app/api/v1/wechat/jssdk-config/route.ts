import { wechatOaJssdkConfig } from '@shop/contracts/wechat-oa/wechat-oa.storefront.contract';
import { wechatOaStorefront } from '@shop/core/wechat-oa';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/wechat/jssdk-config` — the four fields `wx.config` wants.
 *
 * No login: the share card on a page a customer opened from a friend needs it
 * before anybody has signed in. The URL's host is checked against the site's own
 * and the operator's list, because a signature over an arbitrary URL would make
 * our jsapi ticket a signing oracle for anybody's page.
 */
export const GET = handle(wechatOaJssdkConfig, (ctx, { query }) =>
  wechatOaStorefront.jssdkConfigFor(ctx, query),
);

export const dynamic = 'force-dynamic';
