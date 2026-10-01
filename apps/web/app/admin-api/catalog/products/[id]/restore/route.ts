import { catalogAdminProductRestore } from '@shop/contracts/catalog/catalog.product.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../src/server';

/** `/admin-api/catalog/products/:id/restore` — out of the recycle bin, always as 下架. */

export const POST = handle(catalogAdminProductRestore, async (ctx, { params }) => {
  const restored = await catalog.adminProductRestore(ctx, params);
  ctx.audit(`product:${params.id}`);
  return restored;
});

export const dynamic = 'force-dynamic';
