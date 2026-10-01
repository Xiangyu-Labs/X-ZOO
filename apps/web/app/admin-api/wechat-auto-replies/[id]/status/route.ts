import { wechatOaReplySetStatus } from '@shop/contracts/wechat-oa/wechat-oa.reply.contract';
import { wechatOaReply } from '@shop/core/wechat-oa';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/wechat-auto-replies/:id/status` — the switch in the list.
 *
 * A sub-resource POST rather than a PATCH on the rule: the list needs to turn a
 * keyword off without sending the whole form back, and the toggle gets its own
 * audit entry.
 */
export const POST = handle(wechatOaReplySetStatus, async (ctx, { params, body }) => {
  const updated = await wechatOaReply.setStatus(ctx, params, body);
  ctx.audit(`wechat-auto-reply:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
