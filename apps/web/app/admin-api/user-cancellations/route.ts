import { userAdminCancellationList } from '@shop/contracts/user/user.admin.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../src/server';

/** `GET /admin-api/user-cancellations` — the 注销申请 review queue. */
export const GET = handle(userAdminCancellationList, (ctx, { query }) =>
  user.adminCancellationList(ctx, query),
);

export const dynamic = 'force-dynamic';
