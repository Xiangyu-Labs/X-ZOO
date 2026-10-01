import {
  wechatOaReplyDelete,
  wechatOaReplyDetail,
  wechatOaReplyUpdate,
} from '@shop/contracts/wechat-oa/wechat-oa.reply.contract';
import { wechatOaReply } from '@shop/core/wechat-oa';
import { handle } from '../../../../src/server';

/** `/admin-api/wechat-auto-replies/:id` — read, edit, soft-delete one rule. */
export const GET = handle(wechatOaReplyDetail, (ctx, { params }) =>
  wechatOaReply.detail(ctx, params),
);

export const PUT = handle(wechatOaReplyUpdate, async (ctx, { params, body }) => {
  const updated = await wechatOaReply.update(ctx, params, body);
  ctx.audit(`wechat-auto-reply:${params.id}`);
  return updated;
});

export const DELETE = handle(wechatOaReplyDelete, async (ctx, { params }) => {
  await wechatOaReply.remove(ctx, params);
  ctx.audit(`wechat-auto-reply:${params.id}`);
});

export const dynamic = 'force-dynamic';
