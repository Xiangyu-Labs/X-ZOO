import { notificationAdminMarkAllRead } from '@shop/contracts/notification/notification.admin.contract';
import { notificationInbox } from '@shop/core/notification';
import { handle } from '../../../../src/server';

export const POST = handle(notificationAdminMarkAllRead, (ctx) =>
  notificationInbox.markAllRead(ctx, 'admin'),
);

export const dynamic = 'force-dynamic';
