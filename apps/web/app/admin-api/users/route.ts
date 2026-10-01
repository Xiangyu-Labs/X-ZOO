import { userAdminCreate, userAdminList } from '@shop/contracts/user/user.admin.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../src/server';

/** `/admin-api/users` — the 客户列表 with its filters, and 新增用户. */
export const GET = handle(userAdminList, (ctx, { query }) => user.adminList(ctx, query));

export const POST = handle(userAdminCreate, async (ctx, { body }) => {
  const created = await user.adminCreate(ctx, body);
  ctx.audit(`user:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
