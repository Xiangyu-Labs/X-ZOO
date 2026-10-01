import { presaleAdminActivitySetStatus } from '@shop/contracts/presale/presale.admin.contract';
import * as presale from '@shop/core/presale';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/presale-activities/:id/status` — the one-click 启用/暂停 from the
 * list. A sub-resource with POST rather than a PATCH on the activity, because
 * it is one decision with its own audit row, not an edit of the campaign.
 */
export const POST = handle(presaleAdminActivitySetStatus, async (ctx, { params, body }) => {
  const updated = await presale.adminActivitySetStatus(ctx, params, body);
  ctx.audit(`presale:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
