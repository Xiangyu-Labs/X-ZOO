import { wechatOaQrcodeScans } from '@shop/contracts/wechat-oa/wechat-oa.qrcode.contract';
import { wechatOaQrcode } from '@shop/core/wechat-oa';
import { handle } from '../../../../../src/server';

/** `/admin-api/wechat-qrcodes/:id/scans` — who scanned, newest first, openid masked. */
export const GET = handle(wechatOaQrcodeScans, (ctx, { params, query }) =>
  wechatOaQrcode.scans(ctx, params, query),
);

export const dynamic = 'force-dynamic';
