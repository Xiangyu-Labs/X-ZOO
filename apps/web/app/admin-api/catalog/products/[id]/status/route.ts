import { catalogAdminProductSetStatus } from '@shop/contracts/catalog/catalog.product.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../src/server';

/**
 * `/admin-api/catalog/products/:id/status` — 上架 / 下架.
 *
 * The single most consequential write in this domain (risk matrix §1): the
 * moment it commits the product is gone from every storefront list and the
 * order path refuses it.
 */

export const POST = handle(catalogAdminProductSetStatus, async (ctx, { params, body }) => {
  const updated = await catalog.adminProductSetStatus(ctx, params, body);
  ctx.audit(`product:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
