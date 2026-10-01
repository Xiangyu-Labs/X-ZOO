import { cmsArticleCreate, cmsArticleList } from '@shop/contracts/cms/cms.admin.contract';
import { articles } from '@shop/core/cms';
import { handle } from '../../../../src/server';

/** `/admin-api/cms/articles` — 文章列表 and 新建文章. */
export const GET = handle(cmsArticleList, (ctx, { query }) => articles.list(ctx, query));

export const POST = handle(cmsArticleCreate, async (ctx, { body }) => {
  const created = await articles.create(ctx, body);
  ctx.audit(`cms:article:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
