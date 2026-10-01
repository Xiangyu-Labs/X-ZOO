import {
  catalogAdminProductCreate,
  catalogAdminProductList,
} from '@shop/contracts/catalog/catalog.product.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../src/server';

/** `/admin-api/catalog/products` — the 商品列表 tabs and the create form. */

export const GET = handle(catalogAdminProductList, (ctx, { query }) =>
  catalog.adminProductList(ctx, query),
);

export const POST = handle(catalogAdminProductCreate, async (ctx, { body }) => {
  const created = await catalog.adminProductCreate(ctx, body);
  ctx.audit(`product:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
