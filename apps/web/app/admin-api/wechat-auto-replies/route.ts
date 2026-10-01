import {
  wechatOaReplyCreate,
  wechatOaReplyList,
} from '@shop/contracts/wechat-oa/wechat-oa.reply.contract';
import { wechatOaReply } from '@shop/core/wechat-oa';
import { handle } from '../../../src/server';

/** `/admin-api/wechat-auto-replies` — the subscribe greeting, the keyword rules, the fallback. */
export const GET = handle(wechatOaReplyList, (ctx, { query }) => wechatOaReply.list(ctx, query));

export const POST = handle(wechatOaReplyCreate, async (ctx, { body }) => {
  const created = await wechatOaReply.create(ctx, body);
  ctx.audit(`wechat-auto-reply:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
