import { catalogMyReviews } from '@shop/contracts/catalog/catalog.review.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../src/server';

/** `/api/v1/me/reviews` — the reviews this shopper wrote. */

export const GET = handle(catalogMyReviews, (ctx, { query }) => catalog.myReviews(ctx, query));

export const dynamic = 'force-dynamic';
