import { defineErrors } from '../_conventions/errors';

/**
 * Coupon error codes.
 *
 * Every one of these is a *refusal the shopper is allowed to see*, so each
 * message says what to do next rather than what the server failed at. The
 * generic 404/422/429 cases come from `commonErrors` and are not repeated here.
 *
 * A refusal that comes from losing a race (sold out, per-user limit, already
 * redeemed) is a 409, not a 500: two people tapping "领取" at the same instant
 * is ordinary traffic, not an incident.
 */
export const couponErrors = defineErrors({
  /** The template id does not exist, is soft-deleted, or is not `active`. */
  COUPON_TEMPLATE_NOT_FOUND: { status: 404, message: '优惠券不存在或已下架' },
  /** Right template, wrong claim mode: a new-user or order-gift coupon is issued, never claimed. */
  COUPON_NOT_CLAIMABLE: { status: 409, message: '该优惠券不支持手动领取' },
  /** `claim_from` / `claim_to` exclude `now`. */
  COUPON_CLAIM_WINDOW_CLOSED: { status: 409, message: '不在该优惠券的领取时间内' },
  /** The conditional decrement of `remaining_count` affected zero rows. */
  COUPON_SOLD_OUT: { status: 409, message: '该优惠券已被领完' },
  /** `user_coupons_slot_uq` refused the insert, or the slot exceeded `per_user_limit`. */
  COUPON_PER_USER_LIMIT_REACHED: { status: 409, message: '您已领取过该优惠券' },

  /** The wallet coupon does not exist, or belongs to somebody else. Same message either way. */
  COUPON_NOT_FOUND: { status: 404, message: '优惠券不存在' },
  /**
   * Held, but not spendable: used, revoked, expired, or not yet valid.
   *
   * One code for all five refusals on purpose. `redeem` learns "no" from a
   * conditional update that affected zero rows, and asking *why* afterwards
   * would be a second read of a row that may have changed again — so the
   * distinction would be a guess dressed up as a fact. COUPON-005 covers all
   * five shapes against this one code.
   */
  COUPON_NOT_USABLE: { status: 409, message: '该优惠券当前不可使用' },
  /** No cart line falls inside the template's product / category scope. */
  COUPON_NOT_APPLICABLE: { status: 409, message: '该优惠券不适用于所选商品' },
  /** The eligible subtotal is below `min_spend`. `details` carries `{ minSpend }`. */
  COUPON_MIN_SPEND_NOT_MET: { status: 409, message: '订单金额未达到该优惠券的使用门槛' },

  /** An admin grant named a user id that does not exist. `details` carries `{ userIds }`. */
  COUPON_GRANT_USER_UNKNOWN: { status: 422, message: '部分用户不存在，请检查后重试' },
  /** A 按筛选发放 whose filter matched nobody. */
  COUPON_GRANT_AUDIENCE_EMPTY: { status: 422, message: '没有符合条件的用户' },
  /** A 按筛选发放 matched more than `MAX_GRANT_AUDIENCE` users. `details` carries `{ max }`. */
  COUPON_GRANT_AUDIENCE_TOO_LARGE: {
    status: 409,
    message: '符合条件的用户超过 1000 人，请缩小筛选范围',
  },
  /** 作废 is only for a coupon the console handed out and nobody has spent. */
  COUPON_NOT_REVOCABLE: { status: 409, message: '只能作废后台发放且未使用的优惠券' },
});

export type CouponErrorCode = keyof typeof couponErrors;
