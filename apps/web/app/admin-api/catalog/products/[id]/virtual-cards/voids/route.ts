import { catalogAdminVirtualCardVoid } from '@shop/contracts/catalog/catalog.product.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../../src/server';

/** `/admin-api/catalog/products/:id/virtual-cards/voids` — 作废 a selection of cards. */

export const POST = handle(catalogAdminVirtualCardVoid, async (ctx, { params, body }) => {
  const result = await catalog.adminVirtualCardVoid(ctx, params, body);
  ctx.audit(`product:${params.id}`);
  return result;
});

export const dynamic = 'force-dynamic';
