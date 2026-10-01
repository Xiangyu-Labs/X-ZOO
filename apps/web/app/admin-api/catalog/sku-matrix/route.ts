import { catalogAdminSkuMatrix } from '@shop/contracts/catalog/catalog.product.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/catalog/sku-matrix` — the spec matrix, computed on the server.
 *
 * A POST because the spec axes go in the body, and it writes nothing. The
 * editor used to build this in the browser while the server built it again on
 * save; the two disagreed, so a combination could be priced in the UI and
 * missing from the database.
 */

export const POST = handle(catalogAdminSkuMatrix, (ctx, { body }) =>
  catalog.adminSkuMatrix(ctx, body),
);

export const dynamic = 'force-dynamic';
