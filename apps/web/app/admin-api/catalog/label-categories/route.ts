import {
  catalogAdminLabelCategoryCreate,
  catalogAdminLabelCategoryList,
} from '@shop/contracts/catalog/catalog.taxonomy.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../src/server';

/** `/admin-api/catalog/label-categories` — the groupings the 商品标签 picker shows. */

export const GET = handle(catalogAdminLabelCategoryList, (ctx, { query }) =>
  catalog.adminLabelCategoryList(ctx, query),
);

export const POST = handle(catalogAdminLabelCategoryCreate, async (ctx, { body }) => {
  const created = await catalog.adminLabelCategoryCreate(ctx, body);
  ctx.audit(`label-category:${created.id}`);
  return created;
});

export const dynamic = 'force-dynamic';
