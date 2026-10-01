import { notificationAdminTemplateTestSend } from '@shop/contracts/notification/notification.admin.contract';
import { notificationPreview } from '@shop/core/notification';
import { handle } from '../../../../../src/server';

/** One real message to one member. Audited: it reaches a real phone and may cost an SMS. */
export const POST = handle(notificationAdminTemplateTestSend, async (ctx, { params, body }) => {
  const result = await notificationPreview.testSend(ctx, params, body);
  ctx.audit(`notification-template:${params.code}:test:${body.channel}:user:${body.userId}`);
  return result;
});

export const dynamic = 'force-dynamic';
