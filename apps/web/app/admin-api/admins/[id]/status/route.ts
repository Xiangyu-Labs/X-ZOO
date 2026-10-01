import { systemAdminSetStatus } from '@shop/contracts/system/system.admin.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/admins/:id/status` — enable or disable an account.
 *
 * A separate endpoint rather than a field on the edit form, because disabling
 * revokes the account's sessions and the audit row should say so plainly.
 */
export const POST = handle(systemAdminSetStatus, async (ctx, { params, body }) => {
  const result = await system.adminSetStatus(ctx, params, body);
  ctx.audit(`admin:${params.id}`);
  return result;
});

export const dynamic = 'force-dynamic';
