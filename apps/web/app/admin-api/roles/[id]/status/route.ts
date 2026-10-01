import { systemRoleSetStatus } from '@shop/contracts/system/system.role.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../../../src/server';

/** `/admin-api/roles/:id/status` — 启用/停用身份. */
export const POST = handle(systemRoleSetStatus, async (ctx, { params, body }) => {
  const role = await system.roleSetStatus(ctx, params, body);
  ctx.audit(`role:${params.id}`);
  return role;
});

export const dynamic = 'force-dynamic';
