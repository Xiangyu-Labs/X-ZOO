import {
  wechatOaMenuCreate,
  wechatOaMenuList,
} from '@shop/contracts/wechat-oa/wechat-oa.menu.contract';
import { wechatOaMenu } from '@shop/core/wechat-oa';
import { handle } from '../../../src/server';

/**
 * `/admin-api/wechat-menus` — the saved menu trees and the create form.
 *
 * Saving is not publishing: nothing here reaches WeChat. `POST …/:id/publish`
 * is the only route that does, and it is the only one that can fail because the
 * account is unreachable.
 */
export const GET = handle(wechatOaMenuList, (ctx, { query }) => wechatOaMenu.list(ctx, query));

export const POST = handle(wechatOaMenuCreate, async (ctx, { body }) => {
  const created = await wechatOaMenu.create(ctx, body);
  ctx.audit(`wechat-menu:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
