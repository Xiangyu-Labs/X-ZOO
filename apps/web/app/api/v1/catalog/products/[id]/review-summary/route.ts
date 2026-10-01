import { catalogProductReviewSummary } from '@shop/contracts/catalog/catalog.review.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../../src/server';

/** `/api/v1/catalog/products/:id/review-summary` — the 好评率 header. */

export const GET = handle(catalogProductReviewSummary, (ctx, { params }) =>
  catalog.productReviewSummary(ctx, params),
);

export const dynamic = 'force-dynamic';
