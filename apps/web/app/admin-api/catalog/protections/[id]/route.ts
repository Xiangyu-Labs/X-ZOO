import {
  catalogAdminProtectionDelete,
  catalogAdminProtectionUpdate,
} from '@shop/contracts/catalog/catalog.taxonomy.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../src/server';

/** `/admin-api/catalog/protections/:id` — edit or delete one guarantee. */

export const PUT = handle(catalogAdminProtectionUpdate, async (ctx, { params, body }) => {
  const updated = await catalog.adminProtectionUpdate(ctx, params, body);
  ctx.audit(`protection:${params.id}`);
  return updated;
});

export const DELETE = handle(catalogAdminProtectionDelete, async (ctx, { params }) => {
  await catalog.adminProtectionDelete(ctx, params);
  ctx.audit(`protection:${params.id}`);
});

export const dynamic = 'force-dynamic';
