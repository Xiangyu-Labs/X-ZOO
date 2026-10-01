import { groupbuyAdminGroupList } from '@shop/contracts/groupbuy/groupbuy.admin.contract';
import * as groupbuy from '@shop/core/groupbuy';
import { handle } from '../../../src/server';

/** `/admin-api/groupbuy-groups` — every team, filterable by campaign and state. */
export const GET = handle(groupbuyAdminGroupList, (ctx, { query }) =>
  groupbuy.adminGroupList(ctx, query),
);

export const dynamic = 'force-dynamic';
