import { couponClaimableList } from '@shop/contracts/coupon/coupon.storefront.contract';
import * as coupon from '@shop/core/coupon';
import { handle } from '../../../../src/server';

/**
 * `/api/v1/coupons` — the 领券中心.
 *
 * `user-optional`: a signed-out visitor sees the campaigns with
 * `claimedCount` and `canClaim` as `null`, which is what lets the same page be
 * cached for anonymous traffic and personalised for a session.
 */
export const GET = handle(couponClaimableList, (ctx, { query }) =>
  coupon.listClaimable(ctx, query),
);

export const dynamic = 'force-dynamic';
