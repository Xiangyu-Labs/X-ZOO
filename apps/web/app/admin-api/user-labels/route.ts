import { userLabelCreate, userLabelList } from '@shop/contracts/user/user.taxonomy.contract';
import * as user from '@shop/core/user';
import { handle } from '../../../src/server';

/** `/admin-api/user-labels` — 用户标签, optionally inside a category. */
export const GET = handle(userLabelList, (ctx, { query }) => user.labelList(ctx, query));

export const POST = handle(userLabelCreate, async (ctx, { body }) => {
  const created = await user.labelCreate(ctx, body);
  ctx.audit(`user-label:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
