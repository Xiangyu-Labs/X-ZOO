import { catalogAdminCategoryTree } from '@shop/contracts/catalog/catalog.category.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../src/server';

/** `/admin-api/catalog/category-tree` — the whole tree, for the pickers. */

export const GET = handle(catalogAdminCategoryTree, (ctx, { query }) =>
  catalog.adminCategoryTree(ctx, query),
);

export const dynamic = 'force-dynamic';
