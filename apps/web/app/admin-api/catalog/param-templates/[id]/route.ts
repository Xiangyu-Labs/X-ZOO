import {
  catalogAdminParamTemplateDelete,
  catalogAdminParamTemplateUpdate,
} from '@shop/contracts/catalog/catalog.taxonomy.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../src/server';

/** `/admin-api/catalog/param-templates/:id` — edit or delete one template. */

export const PUT = handle(catalogAdminParamTemplateUpdate, async (ctx, { params, body }) => {
  const updated = await catalog.adminParamTemplateUpdate(ctx, params, body);
  ctx.audit(`param-template:${params.id}`);
  return updated;
});

export const DELETE = handle(catalogAdminParamTemplateDelete, async (ctx, { params }) => {
  await catalog.adminParamTemplateDelete(ctx, params);
  ctx.audit(`param-template:${params.id}`);
});

export const dynamic = 'force-dynamic';
