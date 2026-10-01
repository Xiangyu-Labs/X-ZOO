import { couponAdminSetStatus } from '@shop/contracts/coupon/coupon.admin.contract';
import * as coupon from '@shop/core/coupon';
import { handle } from '../../../../../src/server';

/**
 * `/admin-api/coupons/:id/status` — the one-click 上架/下架 from the list.
 *
 * A sub-resource POST rather than a PATCH on the campaign: the toggle carries
 * its own permission and its own audit entry, and the list needs it without
 * sending back the whole form.
 */
export const POST = handle(couponAdminSetStatus, async (ctx, { params, body }) => {
  const updated = await coupon.adminSetStatus(ctx, params, body);
  ctx.audit(`coupon:${params.id}`);
  return updated;
});

export const dynamic = 'force-dynamic';
