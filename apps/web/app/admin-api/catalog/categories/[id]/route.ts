import {
  catalogAdminCategoryDelete,
  catalogAdminCategoryDetail,
  catalogAdminCategoryUpdate,
} from '@shop/contracts/catalog/catalog.category.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../src/server';

/** `/admin-api/catalog/categories/:id` — read, edit (including a move), soft-delete. */

export const GET = handle(catalogAdminCategoryDetail, (ctx, { params }) =>
  catalog.adminCategoryDetail(ctx, params),
);

export const PUT = handle(catalogAdminCategoryUpdate, async (ctx, { params, body }) => {
  const updated = await catalog.adminCategoryUpdate(ctx, params, body);
  ctx.audit(`category:${params.id}`);
  return updated;
});

export const DELETE = handle(catalogAdminCategoryDelete, async (ctx, { params }) => {
  await catalog.adminCategoryDelete(ctx, params);
  ctx.audit(`category:${params.id}`);
});

export const dynamic = 'force-dynamic';
