import { wechatOaQrcodeSetStatus } from '@shop/contracts/wechat-oa/wechat-oa.qrcode.contract';
import { wechatOaQrcode } from '@shop/core/wechat-oa';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/wechat-qrcodes/:id/status` — stop answering scans of this poster.
 *
 * Disabling silences the reply; the scan is still counted, because the poster
 * is still on the wall and the channel report has to say so.
 */
export const POST = handle(wechatOaQrcodeSetStatus, async (ctx, { params, body }) => {
  const updated = await wechatOaQrcode.setStatus(ctx, params, body);
  ctx.audit(`wechat-qrcode:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
