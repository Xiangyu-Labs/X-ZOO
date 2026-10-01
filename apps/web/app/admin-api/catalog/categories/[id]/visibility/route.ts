import { catalogAdminCategorySetVisibility } from '@shop/contracts/catalog/catalog.category.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../src/server';

/**
 * `/admin-api/catalog/categories/:id/visibility` — the 显示/隐藏 switch.
 *
 * Its own sub-resource rather than a field of the edit form: an operator with
 * the list open flips it without loading, or overwriting, the whole category.
 */

export const POST = handle(catalogAdminCategorySetVisibility, async (ctx, { params, body }) => {
  const updated = await catalog.adminCategorySetVisibility(ctx, params, body);
  ctx.audit(`category:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
