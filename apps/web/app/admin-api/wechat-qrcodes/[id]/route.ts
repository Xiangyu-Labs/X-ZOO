import {
  wechatOaQrcodeDelete,
  wechatOaQrcodeDetail,
  wechatOaQrcodeUpdate,
} from '@shop/contracts/wechat-oa/wechat-oa.qrcode.contract';
import { wechatOaQrcode } from '@shop/core/wechat-oa';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/wechat-qrcodes/:id` — read, edit, retire one code.
 *
 * The body cannot carry `scene`: it is printed on posters that are already on
 * walls, and changing it would detach every future scan from its channel.
 */
export const GET = handle(wechatOaQrcodeDetail, (ctx, { params }) =>
  wechatOaQrcode.detail(ctx, params),
);

export const PUT = handle(wechatOaQrcodeUpdate, async (ctx, { params, body }) => {
  const updated = await wechatOaQrcode.update(ctx, params, body);
  ctx.audit(`wechat-qrcode:${params.id}`);
  return updated;
});

export const DELETE = handle(wechatOaQrcodeDelete, async (ctx, { params }) => {
  await wechatOaQrcode.remove(ctx, params);
  ctx.audit(`wechat-qrcode:${params.id}`);
});

export const dynamic = 'force-dynamic';
