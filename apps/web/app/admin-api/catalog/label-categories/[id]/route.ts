import {
  catalogAdminLabelCategoryDelete,
  catalogAdminLabelCategoryUpdate,
} from '@shop/contracts/catalog/catalog.taxonomy.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/catalog/label-categories/:id` — edit or delete a grouping.
 *
 * Deleting detaches its labels rather than taking them with it: a grouping is
 * a filing decision, and the labels are on live products.
 */

export const PUT = handle(catalogAdminLabelCategoryUpdate, async (ctx, { params, body }) => {
  const updated = await catalog.adminLabelCategoryUpdate(ctx, params, body);
  ctx.audit(`label-category:${params.id}`);
  return updated;
});

export const DELETE = handle(catalogAdminLabelCategoryDelete, async (ctx, { params }) => {
  await catalog.adminLabelCategoryDelete(ctx, params);
  ctx.audit(`label-category:${params.id}`);
});

export const dynamic = 'force-dynamic';
