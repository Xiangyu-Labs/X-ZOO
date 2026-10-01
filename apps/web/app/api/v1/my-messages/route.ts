import { notificationMyList } from '@shop/contracts/notification/notification.storefront.contract';
import { notificationInbox } from '@shop/core/notification';
import { handle } from '../../../../src/server';

/** 站内信. Reading the list never marks anything read. */
export const GET = handle(notificationMyList, (ctx, { query }) =>
  notificationInbox.list(ctx, 'user', query),
);

export const dynamic = 'force-dynamic';
