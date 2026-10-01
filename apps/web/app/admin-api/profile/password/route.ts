import { systemProfileChangePassword } from '@shop/contracts/system/system.admin.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/profile/password` — change my own password.
 *
 * Requires the current password, and revokes every other session afterwards —
 * including this one, so the browser is sent back to the login screen. That is
 * the point: "change my password" is what somebody does when they think a
 * session is not theirs any more.
 */
export const POST = handle(systemProfileChangePassword, async (ctx, { body }) => {
  const result = await system.profileChangePassword(ctx, body);
  ctx.audit('admin:self');
  return result;
});

export const dynamic = 'force-dynamic';
