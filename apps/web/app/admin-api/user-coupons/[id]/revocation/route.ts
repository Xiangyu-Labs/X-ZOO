import { couponAdminRevokeUserCoupon } from '@shop/contracts/coupon/coupon.admin.contract';
import * as coupon from '@shop/core/coupon';
import { handle } from '../../../../../src/server';

/** `/admin-api/user-coupons/:id/revocation` — 作废 a coupon the console handed out. */
export const POST = handle(couponAdminRevokeUserCoupon, async (ctx, { params }) => {
  const result = await coupon.adminRevokeUserCoupon(ctx, params);
  ctx.audit(`user-coupon:${params.id}`);
  return result;
});

export const dynamic = 'force-dynamic';
