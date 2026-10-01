import { describe, expect, it } from 'vitest';
import {
  claimCardState,
  claimErrorText,
  claimState,
  heldText,
  walletCardState,
} from './claim-state';

const base = {
  canClaim: true,
  claimedCount: 0,
  remainingCount: 10,
  isUnlimitedSupply: false,
  perUserLimit: 2,
} as const;

describe('claimState', () => {
  it.each([
    ['anonymous', { ...base, canClaim: null, claimedCount: null }, 'claimable'],
    ['signed in, none held', base, 'claimable'],
    ['one held, one more allowed', { ...base, claimedCount: 1 }, 'claimed'],
    ['at the per-user limit', { ...base, canClaim: false, claimedCount: 2 }, 'limit'],
    ['sold out, none held', { ...base, remainingCount: 0 }, 'sold-out'],
    [
      'sold out, anonymous',
      { ...base, remainingCount: 0, canClaim: null, claimedCount: null },
      'sold-out',
    ],
    ['sold out but one held', { ...base, remainingCount: 0, claimedCount: 1 }, 'limit'],
    [
      'unlimited supply never sells out',
      { ...base, remainingCount: null, isUnlimitedSupply: true },
      'claimable',
    ],
    ['refused and none held', { ...base, canClaim: false }, 'closed'],
  ] as const)('%s → %s', (_name, coupon, state) => {
    expect(claimState(coupon)).toBe(state);
  });
});

describe('claimCardState', () => {
  it('maps a held-to-the-limit coupon to 去使用 and a sold-out one to its stamp', () => {
    expect(claimCardState('limit')).toBe('claimed');
    expect(claimCardState('claimed')).toBe('claimable');
    expect(claimCardState('sold-out')).toBe('sold-out');
    expect(claimCardState('closed')).toBe('unusable');
  });
});

describe('heldText', () => {
  it('counts what the shopper holds', () => {
    expect(heldText({ claimedCount: 0, perUserLimit: 2 })).toBe('');
    expect(heldText({ claimedCount: 1, perUserLimit: 2 })).toBe('已领 1/2 张');
    expect(heldText({ claimedCount: 3, perUserLimit: null })).toBe('已领 3 张');
  });
});

describe('claimErrorText', () => {
  it('words the refusals', () => {
    expect(claimErrorText('COUPON_SOLD_OUT', 'x')).toBe('来晚了，券已抢光');
    expect(claimErrorText('COUPON_PER_USER_LIMIT_REACHED', 'x')).toBe('已达领取上限');
    expect(claimErrorText(undefined, '网络异常')).toBe('网络异常');
  });
});

describe('walletCardState', () => {
  it('shows unused coupons as usable', () => {
    expect(walletCardState('unused')).toBe('usable');
    expect(walletCardState('expired')).toBe('expired');
  });
});
