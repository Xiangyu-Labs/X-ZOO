import { wechatOaMenuPublish } from '@shop/contracts/wechat-oa/wechat-oa.menu.contract';
import { wechatOaMenu } from '@shop/core/wechat-oa';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/wechat-menus/:id/publish` — push the tree to WeChat and, only if
 * WeChat accepted it, mark the row live.
 *
 * Its own atom (`wechat-oa:menu:publish`): editing a draft changes a row,
 * publishing changes what every follower sees within minutes.
 */
export const POST = handle(wechatOaMenuPublish, async (ctx, { params }) => {
  const published = await wechatOaMenu.publish(ctx, params);
  ctx.audit(`wechat-menu:${params.id}`);
  return published;
});

export const dynamic = 'force-dynamic';
