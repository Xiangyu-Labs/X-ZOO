import { wechatOaMenuCurrent } from '@shop/contracts/wechat-oa/wechat-oa.menu.contract';
import { wechatOaMenu } from '@shop/core/wechat-oa';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/wechat-menus/current` — the tree followers are looking at.
 *
 * A static segment next to `[id]`, which the App Router matches first, so the
 * word `current` can never be read as a menu id.
 */
export const GET = handle(wechatOaMenuCurrent, (ctx) => wechatOaMenu.current(ctx));

export const dynamic = 'force-dynamic';
