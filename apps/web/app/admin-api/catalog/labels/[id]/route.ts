import {
  catalogAdminLabelDelete,
  catalogAdminLabelUpdate,
} from '@shop/contracts/catalog/catalog.taxonomy.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../src/server';

/** `/admin-api/catalog/labels/:id` — edit or delete one label. */

export const PUT = handle(catalogAdminLabelUpdate, async (ctx, { params, body }) => {
  const updated = await catalog.adminLabelUpdate(ctx, params, body);
  ctx.audit(`label:${params.id}`);
  return updated;
});

export const DELETE = handle(catalogAdminLabelDelete, async (ctx, { params }) => {
  await catalog.adminLabelDelete(ctx, params);
  ctx.audit(`label:${params.id}`);
});

export const dynamic = 'force-dynamic';
