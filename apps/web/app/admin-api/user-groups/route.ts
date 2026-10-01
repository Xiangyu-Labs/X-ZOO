import { userGroupCreate, userGroupList } from '@shop/contracts/user/user.taxonomy.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../src/server';

/** `/admin-api/user-groups` — 用户分组, one customer to many groups. */
export const GET = handle(userGroupList, (ctx, { query }) => user.groupList(ctx, query));

export const POST = handle(userGroupCreate, async (ctx, { body }) => {
  const created = await user.groupCreate(ctx, body);
  ctx.audit(`user-group:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
