import {
  systemRoleDelete,
  systemRoleDetail,
  systemRoleUpdate,
} from '@shop/contracts/system/system.role.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/roles/:id`.
 *
 * Editing the grants of a role revokes the sessions of every admin holding it,
 * because a session carries the permissions it was created with. Without that,
 * taking an atom away would not take effect until the person logged out.
 */
export const GET = handle(systemRoleDetail, (ctx, { params }) => system.roleDetail(ctx, params));

export const PUT = handle(systemRoleUpdate, async (ctx, { params, body }) => {
  const role = await system.roleUpdate(ctx, params, body);
  ctx.audit(`role:${params.id}`);
  return role;
});

export const DELETE = handle(systemRoleDelete, async (ctx, { params }) => {
  await system.roleDelete(ctx, params);
  ctx.audit(`role:${params.id}`);
});

export const dynamic = 'force-dynamic';
