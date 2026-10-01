import {
  catalogAdminVirtualCardImport,
  catalogAdminVirtualCardList,
} from '@shop/contracts/catalog/catalog.product.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../src/server';

/**
 * `/admin-api/catalog/products/:id/virtual-cards` — the card pool.
 *
 * `catalog:card:read` is its own permission atom because these rows are
 * redeemable secrets: seeing a card number is not seeing a product.
 */

export const GET = handle(catalogAdminVirtualCardList, (ctx, { params, query }) =>
  catalog.adminVirtualCardList(ctx, params, query),
);

export const POST = handle(catalogAdminVirtualCardImport, async (ctx, { params, body }) => {
  const result = await catalog.adminVirtualCardImport(ctx, params, body);
  ctx.audit(`product:${params.id}`);
  return result;
});

export const dynamic = 'force-dynamic';
