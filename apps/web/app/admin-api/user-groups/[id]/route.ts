import { userGroupDelete, userGroupUpdate } from '@shop/contracts/user/user.taxonomy.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../src/server';

export const PUT = handle(userGroupUpdate, async (ctx, { params, body }) => {
  const updated = await user.groupUpdate(ctx, params, body);
  ctx.audit(`user-group:${params.id}`);
  return updated;
});

export const DELETE = handle(userGroupDelete, async (ctx, { params }) => {
  await user.groupDelete(ctx, params);
  ctx.audit(`user-group:${params.id}`);
});

export const dynamic = 'force-dynamic';
