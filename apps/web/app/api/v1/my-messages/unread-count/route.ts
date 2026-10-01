import { notificationMyUnreadCount } from '@shop/contracts/notification/notification.storefront.contract';
import { notificationInbox } from '@shop/core/notification';
import { handle } from '../../../../../src/server';

export const GET = handle(notificationMyUnreadCount, (ctx) =>
  notificationInbox.unreadCount(ctx, 'user'),
);

export const dynamic = 'force-dynamic';
