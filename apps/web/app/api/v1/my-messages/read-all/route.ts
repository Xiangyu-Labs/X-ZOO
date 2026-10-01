import { notificationMyMarkAllRead } from '@shop/contracts/notification/notification.storefront.contract';
import { notificationInbox } from '@shop/core/notification';
import { handle } from '../../../../../src/server';

export const POST = handle(notificationMyMarkAllRead, (ctx) =>
  notificationInbox.markAllRead(ctx, 'user'),
);

export const dynamic = 'force-dynamic';
