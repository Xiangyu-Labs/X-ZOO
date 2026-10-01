import { couponAdminGrant } from '@shop/contracts/coupon/coupon.admin.contract';
import * as coupon from '@shop/core/coupon';
import { handle } from '../../../../../src/server';

/** `/admin-api/coupons/:id/grants` — hand this campaign's coupons to named users. */
export const POST = handle(couponAdminGrant, async (ctx, { params, body }) => {
  const result = await coupon.adminGrant(ctx, params, body);
  ctx.audit(`coupon:${params.id}`);
  return result;
});

export const dynamic = 'force-dynamic';
