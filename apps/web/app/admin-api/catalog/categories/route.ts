import {
  catalogAdminCategoryCreate,
  catalogAdminCategoryList,
} from '@shop/contracts/catalog/catalog.category.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../src/server';

/** `/admin-api/catalog/categories` — the 商品分类 list and the create form. */

export const GET = handle(catalogAdminCategoryList, (ctx, { query }) =>
  catalog.adminCategoryList(ctx, query),
);

export const POST = handle(catalogAdminCategoryCreate, async (ctx, { body }) => {
  const created = await catalog.adminCategoryCreate(ctx, body);
  ctx.audit(`category:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
