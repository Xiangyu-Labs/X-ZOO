import { catalogAdminReviewSetStatus } from '@shop/contracts/catalog/catalog.review.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../src/server';

/** `/admin-api/catalog/reviews/:id/status` — 显示 / 隐藏 one review. */

export const POST = handle(catalogAdminReviewSetStatus, async (ctx, { params, body }) => {
  const updated = await catalog.adminReviewSetStatus(ctx, params, body);
  ctx.audit(`review:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
