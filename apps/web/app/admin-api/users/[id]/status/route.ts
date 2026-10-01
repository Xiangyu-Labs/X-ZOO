import { userAdminSetStatus } from '@shop/contracts/user/user.admin.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../../src/server';

/**
 * `POST /admin-api/users/:id/status` — 启用 / 禁用.
 *
 * Disabling bumps `password_version`, so the banned account's live tokens stop
 * resolving now rather than whenever they happened to expire.
 */
export const POST = handle(userAdminSetStatus, async (ctx, { params, body }) => {
  const detail = await user.adminSetStatus(ctx, params, body);
  ctx.audit(`user:${params.id}`);
  return detail;
});

export const dynamic = 'force-dynamic';
