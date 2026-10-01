import { notificationMyMarkRead } from '@shop/contracts/notification/notification.storefront.contract';
import { notificationInbox } from '@shop/core/notification';
import { handle } from '../../../../../../src/server';

export const POST = handle(notificationMyMarkRead, (ctx, { params }) =>
  notificationInbox.markRead(ctx, 'user', params),
);

export const dynamic = 'force-dynamic';
