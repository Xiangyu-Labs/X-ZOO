import type { ResponseOf } from '@shop/api-client';
import type { CouponCardState } from '@/ui/coupon-card';

export type ClaimableCoupon = ResponseOf<'coupon.claimableList'>['items'][number];
export type UserCoupon = ResponseOf<'coupon.myList'>['items'][number];

/**
 * A coupon on 领券中心, from the caller's side (COUPON-001…008):
 *
 * - `claimable`: 立即领取 (an anonymous visitor too: the tap asks for a login first);
 * - `claimed`: the shopper holds it and may take more (「已领 1 张」, 立即领取 stays);
 * - `limit`: the shopper holds as many as one may (去使用);
 * - `sold-out`: none left, and the shopper holds none;
 * - `closed`: not claimable for this shopper, holding none (e.g. a new-user coupon).
 */
export type ClaimState = 'claimable' | 'claimed' | 'limit' | 'sold-out' | 'closed';

export function claimState(
  coupon: Pick<
    ClaimableCoupon,
    'canClaim' | 'claimedCount' | 'remainingCount' | 'isUnlimitedSupply'
  >,
): ClaimState {
  const held = coupon.claimedCount ?? 0;
  const soldOut = !coupon.isUnlimitedSupply && coupon.remainingCount === 0;
  if (coupon.canClaim === false) return held > 0 ? 'limit' : soldOut ? 'sold-out' : 'closed';
  if (soldOut) return held > 0 ? 'limit' : 'sold-out';
  return held > 0 ? 'claimed' : 'claimable';
}

/** The card for a claim state: `limit` shows 去使用, `closed` looks like 已抢光 minus the stamp. */
export function claimCardState(state: ClaimState): CouponCardState {
  switch (state) {
    case 'claimable':
    case 'claimed':
      return 'claimable';
    case 'limit':
      return 'claimed';
    case 'sold-out':
      return 'sold-out';
    case 'closed':
      return 'unusable';
  }
}

/** The small line under a claimed coupon: 「已领 1 张」, 「已领 2/2 张」. */
export function heldText(coupon: Pick<ClaimableCoupon, 'claimedCount' | 'perUserLimit'>): string {
  const held = coupon.claimedCount ?? 0;
  if (held === 0) return '';
  return coupon.perUserLimit ? `已领 ${held}/${coupon.perUserLimit} 张` : `已领 ${held} 张`;
}

/** What a refused claim says (the server's code, in the shopper's words). */
export function claimErrorText(code: string | undefined, fallback: string): string {
  switch (code) {
    case 'COUPON_SOLD_OUT':
      return '来晚了，券已抢光';
    case 'COUPON_PER_USER_LIMIT_REACHED':
      return '已达领取上限';
    case 'COUPON_CLAIM_WINDOW_CLOSED':
      return '不在领取时间内';
    case 'COUPON_NOT_CLAIMABLE':
    case 'COUPON_TEMPLATE_NOT_FOUND':
      return '这张券暂不可领取';
    default:
      return fallback;
  }
}

export type WalletTab = 'unused' | 'used' | 'expired';

/** The wallet card state for a tab. */
export function walletCardState(tab: WalletTab): CouponCardState {
  return tab === 'unused' ? 'usable' : tab;
}
