import { systemAdminCreate, systemAdminList } from '@shop/contracts/system/system.admin.contract';
import * as system from '@shop/core/system';
import { handle } from '../../../src/server';

/** `/admin-api/admins` — 管理员列表 and 新增管理员. */
export const GET = handle(systemAdminList, (ctx, { query }) => system.adminList(ctx, query));

export const POST = handle(systemAdminCreate, async (ctx, { body }) => {
  const created = await system.adminCreate(ctx, body);
  ctx.audit(`admin:${created.admin.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
