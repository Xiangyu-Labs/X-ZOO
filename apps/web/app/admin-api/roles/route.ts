import { systemRoleCreate, systemRoleList } from '@shop/contracts/system/system.role.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../src/server';

/** `/admin-api/roles` — 身份管理. */
export const GET = handle(systemRoleList, (ctx, { query }) => system.roleList(ctx, query));

export const POST = handle(systemRoleCreate, async (ctx, { body }) => {
  const role = await system.roleCreate(ctx, body);
  ctx.audit(`role:${role.id}`);
  return role;
});

export const dynamic = 'force-dynamic';
