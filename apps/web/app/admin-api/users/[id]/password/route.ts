import { userAdminResetPassword } from '@shop/contracts/user/user.admin.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../src/server';

/**
 * `POST /admin-api/users/:id/password` — support resets a suspected-stolen account.
 *
 * Every live session dies with it. The new password is never echoed back: the
 * operator reads it out and it stays out of the audit log.
 */
export const POST = handle(userAdminResetPassword, async (ctx, { params, body }) => {
  const result = await user.adminResetPassword(ctx, params, body);
  ctx.audit(`user:${params.id}`);
  return result;
});

export const dynamic = 'force-dynamic';
