import {
  catalogAdminReviewCreate,
  catalogAdminReviewList,
} from '@shop/contracts/catalog/catalog.review.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/catalog/reviews` — 评价管理, including 虚拟评论.
 *
 * A POST here writes a review nobody bought: `orderItemId` stays null, which
 * is exactly why the uniqueness index is on the order line and not on
 * `(product, user)`.
 */

export const GET = handle(catalogAdminReviewList, (ctx, { query }) =>
  catalog.adminReviewList(ctx, query),
);

export const POST = handle(catalogAdminReviewCreate, async (ctx, { body }) => {
  const created = await catalog.adminReviewCreate(ctx, body);
  ctx.audit(`review:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
