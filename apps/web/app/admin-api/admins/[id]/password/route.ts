import { systemAdminResetPassword } from '@shop/contracts/system/system.admin.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/admins/:id/password` — reset somebody else's password.
 *
 * Every session that account holds is revoked with it: the permissions a
 * session carries were cached when it was created, and a password reset is the
 * moment you least want an old session to survive.
 */
export const POST = handle(systemAdminResetPassword, async (ctx, { params, body }) => {
  const result = await system.adminResetPassword(ctx, params, body);
  ctx.audit(`admin:${params.id}`);
  return result;
});

export const dynamic = 'force-dynamic';
