import { cmsCategoryCreate, cmsCategoryList } from '@shop/contracts/cms/cms.admin.contract';
import { categories } from '@shop/core/cms';
import { handle } from '../../../../src/server';

/** `/admin-api/cms/article-categories` — the flat, depth-first tree and 新建分类. */
export const GET = handle(cmsCategoryList, (ctx, { query }) => categories.list(ctx, query));

export const POST = handle(cmsCategoryCreate, async (ctx, { body }) => {
  const created = await categories.create(ctx, body);
  ctx.audit(`cms:article-category:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
