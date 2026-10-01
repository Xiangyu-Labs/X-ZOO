import { catalogProductList } from '@shop/contracts/catalog/catalog.storefront.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/catalog/products` — the storefront list, and search.
 *
 * Only `status = 'on_shelf'` rows, always: the filter is in the repository,
 * not in this file, so there is no route that can forget it.
 */

export const GET = handle(catalogProductList, (ctx, { query }) => catalog.productList(ctx, query));

export const dynamic = 'force-dynamic';
