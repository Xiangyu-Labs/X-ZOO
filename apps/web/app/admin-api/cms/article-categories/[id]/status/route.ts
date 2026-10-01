import { cmsCategorySetStatus } from '@shop/contracts/cms/cms.admin.contract';
import { categories } from '@shop/core/cms';
import { handle } from '../../../../../../src/server';

/** 显示 / 隐藏 — hiding a parent hides its children from the storefront too. */
export const POST = handle(cmsCategorySetStatus, async (ctx, { params, body }) => {
  const updated = await categories.setStatus(ctx, params, body);
  ctx.audit(`cms:article-category:${updated.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
