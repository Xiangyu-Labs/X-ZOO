import {
  userLabelCategoryDelete,
  userLabelCategoryUpdate,
} from '@shop/contracts/user/user.taxonomy.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../../src/server';

export const PUT = handle(userLabelCategoryUpdate, async (ctx, { params, body }) => {
  const updated = await user.labelCategoryUpdate(ctx, params, body);
  ctx.audit(`user-label-category:${params.id}`);
  return updated;
});

export const DELETE = handle(userLabelCategoryDelete, async (ctx, { params }) => {
  await user.labelCategoryDelete(ctx, params);
  ctx.audit(`user-label-category:${params.id}`);
});

export const dynamic = 'force-dynamic';
