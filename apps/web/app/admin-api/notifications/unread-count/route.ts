import { notificationAdminUnreadCount } from '@shop/contracts/notification/notification.admin.contract';
import { notificationInbox } from '@shop/core/notification';
import { handle } from '../../../../src/server';

export const GET = handle(notificationAdminUnreadCount, (ctx) =>
  notificationInbox.unreadCount(ctx, 'admin'),
);

export const dynamic = 'force-dynamic';
