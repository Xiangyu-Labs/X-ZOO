import { couponClaim } from '@shop/contracts/coupon/coupon.storefront.contract';
import * as coupon from '@shop/core/coupon';
import { handle } from '../../../../../../src/server';

/**
 * `/api/v1/coupons/:id/claims` — 领取.
 *
 * A POST that creates a sub-resource, so the 201 and the returned wallet
 * coupon are the ordinary REST shape rather than an RPC-flavoured
 * `/coupons/:id/receive`. Every refusal (sold out, already claimed, window
 * closed) is a 409 from the service; this file does not know about any of them.
 */
export const POST = handle(couponClaim, (ctx, { params }) => coupon.claim(ctx, params));

export const dynamic = 'force-dynamic';
