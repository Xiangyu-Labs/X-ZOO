import { notificationAdminInboxList } from '@shop/contracts/notification/notification.admin.contract';
import { notificationInbox } from '@shop/core/notification';
import { handle } from '../../../src/server';

/** The admin's own inbox. No atom of its own: the bell must work for an account with no grants. */
export const GET = handle(notificationAdminInboxList, (ctx, { query }) =>
  notificationInbox.list(ctx, 'admin', query),
);

export const dynamic = 'force-dynamic';
