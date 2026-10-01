import {
  catalogAdminProductDelete,
  catalogAdminProductDetail,
  catalogAdminProductUpdate,
} from '@shop/contracts/catalog/catalog.product.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../src/server';

/** `/admin-api/catalog/products/:id` — read, edit, move to the recycle bin. */

export const GET = handle(catalogAdminProductDetail, (ctx, { params }) =>
  catalog.adminProductDetail(ctx, params),
);

export const PUT = handle(catalogAdminProductUpdate, async (ctx, { params, body }) => {
  const updated = await catalog.adminProductUpdate(ctx, params, body);
  ctx.audit(`product:${params.id}`);
  return updated;
});

export const DELETE = handle(catalogAdminProductDelete, async (ctx, { params }) => {
  await catalog.adminProductDelete(ctx, params);
  ctx.audit(`product:${params.id}`);
});

export const dynamic = 'force-dynamic';
