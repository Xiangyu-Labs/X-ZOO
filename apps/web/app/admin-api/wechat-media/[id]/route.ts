import { wechatOaMediaDelete } from '@shop/contracts/wechat-oa/wechat-oa.media.contract';
import { wechatOaMedia } from '@shop/core/wechat-oa';
import { handle } from '../../../../src/server';

/** `/admin-api/wechat-media/:id` — drop the handle here and, for permanent material, at WeChat. */
export const DELETE = handle(wechatOaMediaDelete, async (ctx, { params }) => {
  await wechatOaMedia.remove(ctx, params);
  ctx.audit(`wechat-medium:${params.id}`);
});

export const dynamic = 'force-dynamic';
