import { userAdminDetail, userAdminUpdate } from '@shop/contracts/user/user.admin.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../src/server';

/** `/admin-api/users/:id` — the detail drawer and the edit form behind it. */
export const GET = handle(userAdminDetail, (ctx, { params }) => user.adminDetail(ctx, params));

export const PUT = handle(userAdminUpdate, async (ctx, { params, body }) => {
  const updated = await user.adminUpdate(ctx, params, body);
  ctx.audit(`user:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
