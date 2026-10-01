import { userAdminBatchSetGroups } from '@shop/contracts/user/user.admin.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../src/server';

/** `POST /admin-api/users/group-assignments` — 批量设置分组 for the ticked rows. */
export const POST = handle(userAdminBatchSetGroups, async (ctx, { body }) => {
  const result = await user.adminBatchSetGroups(ctx, body);
  ctx.audit(`user-groups:${body.mode}:${body.userIds.length}`);
  return result;
});

export const dynamic = 'force-dynamic';
