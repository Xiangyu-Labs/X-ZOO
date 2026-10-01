import {
  systemAdminDelete,
  systemAdminDetail,
  systemAdminUpdate,
} from '@shop/contracts/system/system.admin.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../../src/server';

/** `/admin-api/admins/:id` — read, edit, soft-delete one account. */
export const GET = handle(systemAdminDetail, (ctx, { params }) => system.adminDetail(ctx, params));

export const PUT = handle(systemAdminUpdate, async (ctx, { params, body }) => {
  const result = await system.adminUpdate(ctx, params, body);
  ctx.audit(`admin:${params.id}`);
  return result;
});

export const DELETE = handle(systemAdminDelete, async (ctx, { params }) => {
  await system.adminDelete(ctx, params);
  ctx.audit(`admin:${params.id}`);
});

export const dynamic = 'force-dynamic';
