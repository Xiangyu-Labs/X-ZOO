import { catalogProductReviews } from '@shop/contracts/catalog/catalog.review.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../../src/server';

/** `/api/v1/catalog/products/:id/reviews` — the 评价 tab. */

export const GET = handle(catalogProductReviews, (ctx, { params, query }) =>
  catalog.productReviews(ctx, params, query),
);

export const dynamic = 'force-dynamic';
