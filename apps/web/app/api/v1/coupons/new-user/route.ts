import { couponNewUserList } from '@shop/contracts/coupon/coupon.storefront.contract';
import * as coupon from '@shop/core/coupon';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/coupons/new-user` — what signing up is worth, for the registration
 * banner. A static segment, so it never collides with `/coupons/:id`.
 */
export const GET = handle(couponNewUserList, (ctx) => coupon.listNewUser(ctx));

export const dynamic = 'force-dynamic';
