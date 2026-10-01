import { notificationAdminTemplateList } from '@shop/contracts/notification/notification.admin.contract';
import { notificationAdmin } from '@shop/core/notification';
import { handle } from '../../../src/server';

/** The list is the registry's, not the table's: these are the events the code can send. */
export const GET = handle(notificationAdminTemplateList, (ctx, { query }) =>
  notificationAdmin.listTemplates(ctx, query),
);

export const dynamic = 'force-dynamic';
