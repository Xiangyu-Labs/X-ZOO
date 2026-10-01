import { notificationAdminTemplateToggleChannel } from '@shop/contracts/notification/notification.admin.contract';
import { notificationAdmin } from '@shop/core/notification';
import { handle } from '../../../../../../src/server';

/** Switching a channel on validates it: an enabled channel with nothing to send is refused here. */
export const POST = handle(
  notificationAdminTemplateToggleChannel,
  async (ctx, { params, body }) => {
    const updated = await notificationAdmin.toggleChannel(ctx, params, body);
    // The channel is part of the target: 谁把短信通知关了 is a different question
    // from 谁改了这个模板, and both are asked of the same template.
    ctx.audit(`notification-template:${params.code}:${params.channel}`);
    return updated;
  },
);

export const dynamic = 'force-dynamic';
