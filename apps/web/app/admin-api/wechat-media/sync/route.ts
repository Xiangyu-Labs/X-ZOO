import { wechatOaMediaSync } from '@shop/contracts/wechat-oa/wechat-oa.media.contract';
import { wechatOaMedia } from '@shop/core/wechat-oa';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/wechat-media/sync` — reconcile our rows with 公众平台.
 *
 * One direction: WeChat is the truth about what exists, because material
 * deleted there renders here as an empty chat bubble.
 */
export const POST = handle(wechatOaMediaSync, async (ctx) => {
  const result = await wechatOaMedia.sync(ctx);
  ctx.audit('wechat-media:sync');
  return result;
});

export const dynamic = 'force-dynamic';
