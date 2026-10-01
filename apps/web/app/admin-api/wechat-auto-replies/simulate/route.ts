import { wechatOaReplySimulate } from '@shop/contracts/wechat-oa/wechat-oa.reply.contract';
import { wechatOaReply } from '@shop/core/wechat-oa';
import { handle } from '../../../../src/server';

/** `POST /admin-api/wechat-auto-replies/simulate` — 回复模拟. Reads only. */
export const POST = handle(wechatOaReplySimulate, (ctx, { body }) =>
  wechatOaReply.simulate(ctx, body),
);

export const dynamic = 'force-dynamic';
