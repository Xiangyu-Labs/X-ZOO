import { couponMyList } from '@shop/contracts/coupon/coupon.storefront.contract';
import * as coupon from '@shop/core/coupon';
import { handle } from '../../../../src/server';

/** `/api/v1/user-coupons` — 我的优惠券, one tab per `state`. */
export const GET = handle(couponMyList, (ctx, { query }) => coupon.listMine(ctx, query));

export const dynamic = 'force-dynamic';
