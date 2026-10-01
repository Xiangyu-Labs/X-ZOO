import { cmsArticleSetStatus } from '@shop/contracts/cms/cms.admin.contract';
import { articles } from '@shop/core/cms';
import { handle } from '../../../../../../src/server';

/** 发布 / 隐藏, the switch on the list row. */
export const POST = handle(cmsArticleSetStatus, async (ctx, { params, body }) => {
  const updated = await articles.setStatus(ctx, params, body);
  ctx.audit(`cms:article:${updated.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
