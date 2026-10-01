import { userAdminBatchSetLabels } from '@shop/contracts/user/user.admin.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../src/server';

/** `POST /admin-api/users/label-assignments` — 批量设置标签 for the ticked rows. */
export const POST = handle(userAdminBatchSetLabels, async (ctx, { body }) => {
  const result = await user.adminBatchSetLabels(ctx, body);
  ctx.audit(`user-labels:${body.mode}:${body.userIds.length}`);
  return result;
});

export const dynamic = 'force-dynamic';
