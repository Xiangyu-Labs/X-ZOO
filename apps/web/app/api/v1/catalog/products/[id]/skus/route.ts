import { catalogProductSkus } from '@shop/contracts/catalog/catalog.storefront.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../../src/server';

/** `/api/v1/catalog/products/:id/skus` — the spec picker's data. */

export const GET = handle(catalogProductSkus, (ctx, { params }) =>
  catalog.productSkus(ctx, params),
);

export const dynamic = 'force-dynamic';
