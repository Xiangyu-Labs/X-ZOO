import { notificationAdminMarkRead } from '@shop/contracts/notification/notification.admin.contract';
import { notificationInbox } from '@shop/core/notification';
import { handle } from '../../../../../src/server';

export const POST = handle(notificationAdminMarkRead, (ctx, { params }) =>
  notificationInbox.markRead(ctx, 'admin', params),
);

export const dynamic = 'force-dynamic';
