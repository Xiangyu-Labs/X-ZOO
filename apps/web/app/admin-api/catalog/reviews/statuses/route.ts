import { catalogAdminReviewBatchSetStatus } from '@shop/contracts/catalog/catalog.review.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/catalog/reviews/statuses` — 批量审核.
 *
 * `updated` counts the rows the one conditional update actually moved, so a
 * re-submitted selection reports 0 rather than claiming a hundred moderation
 * decisions that did not happen.
 */

export const POST = handle(catalogAdminReviewBatchSetStatus, async (ctx, { body }) => {
  const result = await catalog.adminReviewBatchSetStatus(ctx, body);
  ctx.audit(`reviews:${body.reviewIds.length}`);
  return result;
});

export const dynamic = 'force-dynamic';
