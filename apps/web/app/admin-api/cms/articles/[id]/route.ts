import {
  cmsArticleDelete,
  cmsArticleDetail,
  cmsArticleUpdate,
} from '@shop/contracts/cms/cms.admin.contract';
import { articles } from '@shop/core/cms';
import { handle } from '../../../../../src/server';

export const GET = handle(cmsArticleDetail, (ctx, { params }) => articles.detail(ctx, params));

export const PUT = handle(cmsArticleUpdate, async (ctx, { params, body }) => {
  const updated = await articles.update(ctx, params, body);
  ctx.audit(`cms:article:${updated.id}`);
  return updated;
});

export const DELETE = handle(cmsArticleDelete, async (ctx, { params }) => {
  const result = await articles.remove(ctx, params);
  ctx.audit(`cms:article:${params.id}`);
  return result;
});

export const dynamic = 'force-dynamic';
