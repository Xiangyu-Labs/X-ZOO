import { notificationAdminLogList } from '@shop/contracts/notification/notification.admin.contract';
import { notificationAdmin } from '@shop/core/notification';
import { handle } from '../../../src/server';

/** The send log is the effects ledger filtered to `scope = 'notification'`; there is no second table. */
export const GET = handle(notificationAdminLogList, (ctx, { query }) =>
  notificationAdmin.listLogs(ctx, query),
);

export const dynamic = 'force-dynamic';
