import { catalogProductDetail } from '@shop/contracts/catalog/catalog.storefront.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../src/server';

/**
 * `/api/v1/catalog/products/:id` — the product page.
 *
 * `user-optional`: a signed-in shopper also gets `favorited` and a 足迹 row.
 */

export const GET = handle(catalogProductDetail, (ctx, { params }) =>
  catalog.productDetail(ctx, params),
);

export const dynamic = 'force-dynamic';
