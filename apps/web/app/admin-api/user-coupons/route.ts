import { couponAdminUserCouponList } from '@shop/contracts/coupon/coupon.admin.contract';
import * as coupon from '@shop/core/coupon';
import { handle } from '../../../src/server';

/**
 * `/admin-api/user-coupons` — every issued coupon, filterable by campaign,
 * user and state. Its own resource because support looks up a *coupon*, not a
 * campaign, when a customer asks where theirs went.
 */
export const GET = handle(couponAdminUserCouponList, (ctx, { query }) =>
  coupon.adminListUserCoupons(ctx, query),
);

export const dynamic = 'force-dynamic';
