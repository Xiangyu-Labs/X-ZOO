import { orderGiftCouponList } from '@shop/contracts/coupon/coupon.gift.contract';
import * as order from '@shop/core/order';
import { handle } from '../../../../../../src/server';

/**
 * `/api/v1/orders/:id/gift-coupons` — 订单赠券.
 *
 * The order domain answers, not the coupon domain: the ownership check is the
 * hard half and `requireOrderRef` is where it lives.
 */
export const GET = handle(orderGiftCouponList, (ctx, { params }) => order.giftCoupons(ctx, params));

export const dynamic = 'force-dynamic';
