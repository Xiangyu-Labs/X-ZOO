import {
  userLabelCategoryCreate,
  userLabelCategoryList,
} from '@shop/contracts/user/user.taxonomy.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../src/server';

/** `/admin-api/user-label-categories` — the groupings the label picker renders. */
export const GET = handle(userLabelCategoryList, (ctx, { query }) =>
  user.labelCategoryList(ctx, query),
);

export const POST = handle(userLabelCategoryCreate, async (ctx, { body }) => {
  const created = await user.labelCategoryCreate(ctx, body);
  ctx.audit(`user-label-category:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
