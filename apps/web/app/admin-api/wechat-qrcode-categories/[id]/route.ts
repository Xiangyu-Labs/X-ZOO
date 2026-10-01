import {
  wechatOaQrcodeCategoryDelete,
  wechatOaQrcodeCategoryUpdate,
} from '@shop/contracts/wechat-oa/wechat-oa.qrcode.contract';
import { wechatOaQrcode } from '@shop/core/wechat-oa';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/wechat-qrcode-categories/:id` — rename, reorder, remove.
 *
 * Removing refuses while codes are still filed here: cascading would orphan
 * their attribution and `set null` would quietly move somebody's channel report
 * into 未分类.
 */
export const PUT = handle(wechatOaQrcodeCategoryUpdate, async (ctx, { params, body }) => {
  const updated = await wechatOaQrcode.updateCategory(ctx, params, body);
  ctx.audit(`wechat-qrcode-category:${params.id}`);
  return updated;
});

export const DELETE = handle(wechatOaQrcodeCategoryDelete, async (ctx, { params }) => {
  await wechatOaQrcode.deleteCategory(ctx, params);
  ctx.audit(`wechat-qrcode-category:${params.id}`);
});

export const dynamic = 'force-dynamic';
