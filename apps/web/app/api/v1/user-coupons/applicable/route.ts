import { couponApplicableList } from '@shop/contracts/coupon/coupon.storefront.contract';
import * as coupon from '@shop/core/coupon';
import { handle } from '../../../../../src/server';

/**
 * `/api/v1/user-coupons/applicable` — the checkout picker.
 *
 * A POST because the cart goes in the body: a GET would have to encode every
 * line in the query string, and carts get long. It writes nothing, so the
 * client may call it on every cart change.
 */
export const POST = handle(couponApplicableList, (ctx, { body }) =>
  coupon.listApplicable(ctx, body),
);

export const dynamic = 'force-dynamic';
