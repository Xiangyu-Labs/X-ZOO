import { cmsCategoryDelete, cmsCategoryUpdate } from '@shop/contracts/cms/cms.admin.contract';
import { categories } from '@shop/core/cms';
import { handle } from '../../../../../src/server';

export const PUT = handle(cmsCategoryUpdate, async (ctx, { params, body }) => {
  const updated = await categories.update(ctx, params, body);
  ctx.audit(`cms:article-category:${updated.id}`);
  return updated;
});

export const DELETE = handle(cmsCategoryDelete, async (ctx, { params }) => {
  const result = await categories.remove(ctx, params);
  ctx.audit(`cms:article-category:${params.id}`);
  return result;
});

export const dynamic = 'force-dynamic';
