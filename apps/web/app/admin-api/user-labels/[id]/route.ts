import { userLabelDelete, userLabelUpdate } from '@shop/contracts/user/user.taxonomy.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../src/server';

export const PUT = handle(userLabelUpdate, async (ctx, { params, body }) => {
  const updated = await user.labelUpdate(ctx, params, body);
  ctx.audit(`user-label:${params.id}`);
  return updated;
});

export const DELETE = handle(userLabelDelete, async (ctx, { params }) => {
  await user.labelDelete(ctx, params);
  ctx.audit(`user-label:${params.id}`);
});

export const dynamic = 'force-dynamic';
