import { wechatOaSubscribeTemplates } from '@shop/contracts/wechat-oa/wechat-oa.storefront.contract';
import { wechatOaStorefront } from '@shop/core/wechat-oa';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/wechat/subscribe-templates` — which template ids to ask permission
 * for at this moment.
 *
 * `wx.requestSubscribeMessage` must run inside a user gesture and takes the ids
 * up front, so the client cannot discover them the way the sender does.
 */
export const GET = handle(wechatOaSubscribeTemplates, (ctx, { query }) =>
  wechatOaStorefront.subscribeTemplatesFor(ctx, query),
);

export const dynamic = 'force-dynamic';
