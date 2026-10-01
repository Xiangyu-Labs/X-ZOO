import { catalogAdminReviewDelete } from '@shop/contracts/catalog/catalog.review.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/catalog/reviews/:id` — delete one review.
 *
 * `catalog:review:delete` is separate from `catalog:review:write`: replying is
 * customer service, removing a customer's words is not.
 */

export const DELETE = handle(catalogAdminReviewDelete, async (ctx, { params }) => {
  await catalog.adminReviewDelete(ctx, params);
  ctx.audit(`review:${params.id}`);
});

export const dynamic = 'force-dynamic';
