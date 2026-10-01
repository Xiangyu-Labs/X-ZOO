import { catalogReviewSubmit } from '@shop/contracts/catalog/catalog.review.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/catalog/reviews` — 发表评价.
 *
 * Addressed by order line, not by product: the uniqueness index on
 * `order_item_id` is what makes a double-tapped button one review and one 409.
 */

export const POST = handle(catalogReviewSubmit, (ctx, { body }) => catalog.reviewSubmit(ctx, body));

export const dynamic = 'force-dynamic';
