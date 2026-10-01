import {
  notificationMyDelete,
  notificationMyDetail,
} from '@shop/contracts/notification/notification.storefront.contract';
import { notificationInbox } from '@shop/core/notification';
import { handle } from '../../../../../src/server';

/** The owner is in the `WHERE`, not in a check after the read: an id is not a capability. */
export const GET = handle(notificationMyDetail, (ctx, { params }) =>
  notificationInbox.detail(ctx, 'user', params),
);

export const DELETE = handle(notificationMyDelete, (ctx, { params }) =>
  notificationInbox.remove(ctx, 'user', params),
);

export const dynamic = 'force-dynamic';
