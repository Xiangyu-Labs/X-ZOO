import { groupbuyAdminGroupDetail } from '@shop/contracts/groupbuy/groupbuy.admin.contract';
import * as groupbuy from '@shop/core/groupbuy';
import { handle } from '../../../../src/server';

/** `/admin-api/groupbuy-groups/:id` — one team and its members. */
export const GET = handle(groupbuyAdminGroupDetail, (ctx, { params }) =>
  groupbuy.adminGroupDetail(ctx, params),
);

export const dynamic = 'force-dynamic';
