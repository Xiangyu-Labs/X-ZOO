import { groupbuyAdminStatistics } from '@shop/contracts/groupbuy/groupbuy.admin.contract';
import * as groupbuy from '@shop/core/groupbuy';
import { handle } from '../../../src/server';

/** `/admin-api/groupbuy-statistics` — teams, paid members and takings per campaign. */
export const GET = handle(groupbuyAdminStatistics, (ctx, { query }) =>
  groupbuy.adminStatistics(ctx, query),
);

export const dynamic = 'force-dynamic';
