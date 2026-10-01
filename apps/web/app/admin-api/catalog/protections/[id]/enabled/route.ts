import { catalogAdminProtectionSetEnabled } from '@shop/contracts/catalog/catalog.taxonomy.admin.contract';
import * as catalog from '@shop/core/catalog';
import { handle } from '../../../../../../src/server';

/** `/admin-api/catalog/protections/:id/enabled` — the 启用 switch. */

export const POST = handle(catalogAdminProtectionSetEnabled, async (ctx, { params, body }) => {
  const updated = await catalog.adminProtectionSetEnabled(ctx, params, body);
  ctx.audit(`protection:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
