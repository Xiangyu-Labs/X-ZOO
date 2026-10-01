import { catalogAdminParamTemplateSetEnabled } from '@shop/contracts/catalog/catalog.taxonomy.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../src/server';

/** `/admin-api/catalog/param-templates/:id/enabled` — the 启用 switch. */

export const POST = handle(catalogAdminParamTemplateSetEnabled, async (ctx, { params, body }) => {
  const updated = await catalog.adminParamTemplateSetEnabled(ctx, params, body);
  ctx.audit(`param-template:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
