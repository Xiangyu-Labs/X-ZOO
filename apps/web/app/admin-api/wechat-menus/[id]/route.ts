import {
  wechatOaMenuDelete,
  wechatOaMenuUpdate,
} from '@shop/contracts/wechat-oa/wechat-oa.menu.contract';
import { wechatOaMenu } from '@shop/core/wechat-oa';
import { handle } from '../../../../src/server';

/** `/admin-api/wechat-menus/:id` — edit the draft, or drop a menu that is not live. */
export const PUT = handle(wechatOaMenuUpdate, async (ctx, { params, body }) => {
  const updated = await wechatOaMenu.update(ctx, params, body);
  ctx.audit(`wechat-menu:${params.id}`);
  return updated;
});

export const DELETE = handle(wechatOaMenuDelete, async (ctx, { params }) => {
  await wechatOaMenu.remove(ctx, params);
  ctx.audit(`wechat-menu:${params.id}`);
});

export const dynamic = 'force-dynamic';
