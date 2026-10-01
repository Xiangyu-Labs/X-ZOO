import { catalogAdminLabelSetEnabled } from '@shop/contracts/catalog/catalog.taxonomy.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../src/server';

/** `/admin-api/catalog/labels/:id/enabled` — the 启用 switch. */

export const POST = handle(catalogAdminLabelSetEnabled, async (ctx, { params, body }) => {
  const updated = await catalog.adminLabelSetEnabled(ctx, params, body);
  ctx.audit(`label:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
