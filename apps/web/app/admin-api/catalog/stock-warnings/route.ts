import { catalogAdminStockWarnings } from '@shop/contracts/catalog/catalog.product.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../src/server';

/** `/admin-api/catalog/stock-warnings` — SKUs at or below the configured threshold. */

export const GET = handle(catalogAdminStockWarnings, (ctx, { query }) =>
  catalog.adminStockWarnings(ctx, query),
);

export const dynamic = 'force-dynamic';
