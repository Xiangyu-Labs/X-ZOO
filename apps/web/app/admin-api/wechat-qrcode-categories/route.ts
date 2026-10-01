import {
  wechatOaQrcodeCategoryCreate,
  wechatOaQrcodeCategoryList,
} from '@shop/contracts/wechat-oa/wechat-oa.qrcode.contract';
import { wechatOaQrcode } from '@shop/core/wechat-oa';
import { handle } from '../../../src/server';

/** `/admin-api/wechat-qrcode-categories` — the folders the channel codes are filed in. */
export const GET = handle(wechatOaQrcodeCategoryList, (ctx, { query }) =>
  wechatOaQrcode.listCategories(ctx, query),
);

export const POST = handle(wechatOaQrcodeCategoryCreate, async (ctx, { body }) => {
  const created = await wechatOaQrcode.createCategory(ctx, body);
  ctx.audit(`wechat-qrcode-category:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
