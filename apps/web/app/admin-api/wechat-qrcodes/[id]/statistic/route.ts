import { wechatOaQrcodeStatistic } from '@shop/contracts/wechat-oa/wechat-oa.qrcode.contract';
import { wechatOaQrcode } from '@shop/core/wechat-oa';
import { handle } from '../../../../../src/server';

/** `/admin-api/wechat-qrcodes/:id/statistic` — daily scans and new followers, Asia/Shanghai. */
export const GET = handle(wechatOaQrcodeStatistic, (ctx, { params, query }) =>
  wechatOaQrcode.statistic(ctx, params, query),
);

export const dynamic = 'force-dynamic';
