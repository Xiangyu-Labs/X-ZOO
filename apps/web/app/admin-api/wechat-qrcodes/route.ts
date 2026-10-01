import {
  wechatOaQrcodeCreate,
  wechatOaQrcodeList,
} from '@shop/contracts/wechat-oa/wechat-oa.qrcode.contract';
import { wechatOaQrcode } from '@shop/core/wechat-oa';
import { handle } from '../../../src/server';

/**
 * `/admin-api/wechat-qrcodes` — the channel codes and their scan counters.
 *
 * `POST` asks WeChat for the ticket first and records the row second, so a
 * refusal leaves no code that cannot be printed.
 */
export const GET = handle(wechatOaQrcodeList, (ctx, { query }) => wechatOaQrcode.list(ctx, query));

export const POST = handle(wechatOaQrcodeCreate, async (ctx, { body }) => {
  const created = await wechatOaQrcode.create(ctx, body);
  ctx.audit(`wechat-qrcode:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
