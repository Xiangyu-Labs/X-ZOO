import { catalogAdminProductExport } from '@shop/contracts/catalog/catalog.product.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../src/server';

/**
 * `/admin-api/catalog/product-export` — the export rows, as JSON.
 *
 * `catalog:product:export` is separate from `catalog:product:write` because
 * the rows carry **cost prices**. Whoever may edit a product should not
 * automatically be able to download the shop's margins.
 */

export const GET = handle(catalogAdminProductExport, async (ctx, { query }) => {
  const result = await catalog.adminProductExport(ctx, query);
  ctx.audit(`product-export:${result.total}`);
  return result;
});

export const dynamic = 'force-dynamic';
