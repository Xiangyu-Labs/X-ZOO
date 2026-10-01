/**
 * The coupon domain's public surface.
 *
 * `docs/conventions.md`: "A domain in `core` may import another domain only
 * through that domain's `index.ts`". So this file is the contract between the
 * coupon domain and the rest of the system, and everything not re-exported here
 * is private — `coupon.repo.ts` in particular, which no other domain may reach.
 *
 * The functions other domains call:
 *
 * | Function          | Caller         | When                                       |
 * | ----------------- | -------------- | ------------------------------------------ |
 * | `quote`           | order          | pricing the cart and confirming an order   |
 * | `redeem`          | order          | inside `createOrder`'s transaction         |
 * | `release`         | order / refund | cancel and refund                          |
 * | `grantNewUser`    | user           | inside the registration transaction        |
 * | `grantOrderGifts` | order          | the order-paid effect handler              |
 * | `revokeOrderGifts`| refund         | a full refund takes the unused gifts back  |
 * | `listOrderGifts`  | order          | the 订单赠券 panel, after the owner check |
 * | `productScope`    | catalog        | the 商品列表's `couponId` filter           |
 *
 * `redeem`, `release`, `grantNewUser` and `grantOrderGifts` take `(tx, ctx, …)`
 * — a transaction the *caller* owns, plus the context they need a clock and a
 * logger from. That argument order matches `recordEffect(tx, ctx, input)`, the
 * platform's other "join the transaction you are already in" primitive.
 */
export {
  // storefront + admin services, called by route files
  adminCreate,
  adminDelete,
  adminDetail,
  adminGrant,
  adminGrantBatch,
  adminList,
  adminListUserCoupons,
  adminRevokeUserCoupon,
  adminSetStatus,
  adminUpdate,
  claim,
  listApplicable,
  listClaimable,
  listHeldNewUser,
  listMine,
  listNewUser,
  // the domain API other domains call
  grantNewUser,
  grantOrderGifts,
  listOrderGifts,
  productScope,
  quote,
  redeem,
  release,
  revokeOrderGifts,
} from './coupon.service';

export type {
  CouponProductScope,
  OrderGiftInput,
  QuoteInput,
  QuoteResult,
  RedeemInput,
  ReleaseInput,
  ReleaseResult,
} from './coupon.service';

export type { CouponLine, CouponTerms } from './coupon.rules';
export { couponPermissions } from './permissions';

/** Jobs reach the sweeps through here; nothing else in `coupon.repo.ts` is public. */
export { expireOverdueCoupons, disableClosedCampaigns } from './coupon.jobs';
