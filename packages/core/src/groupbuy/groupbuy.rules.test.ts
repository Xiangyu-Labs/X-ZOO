import { describe, expect, it } from 'vitest';
import { DomainError } from '../kernel/errors';
import { Money } from '../kernel/money';
import {
  assertActivityDiscountApplied,
  assertActivityPriceApplied,
  assertCompletable,
  assertGroupJoinable,
  assertQuantityAllowed,
  assertWithdrawable,
  expectedGoodsTotal,
  groupExpiresAt,
  isActivityOpen,
  isGroupJoinable,
  maskNickname,
  seatsLeft,
  wasVirtuallyFilled,
} from './groupbuy.rules';

/**
 * The group-buy decisions that need no database.
 *
 * These are the cheap half. The expensive half — seats, activity stock,
 * leadership — is in `groupbuy.int.test.ts` and `groupbuy.concurrency.int.test.ts`,
 * because those answers are row counts and a unit test cannot produce one.
 */

const NOW = new Date('2026-06-01T12:00:00.000Z');

const activity = (over: Partial<Parameters<typeof isActivityOpen>[0]> = {}) => ({
  status: 'active' as const,
  startAt: new Date('2026-05-01T00:00:00.000Z'),
  endAt: new Date('2026-07-01T00:00:00.000Z'),
  deletedAt: null,
  ...over,
});

const group = (over: Partial<Parameters<typeof isGroupJoinable>[0]> = {}) => ({
  status: 'forming' as const,
  seatsTotal: 3,
  seatsTaken: 1,
  expiresAt: new Date('2026-06-02T12:00:00.000Z'),
  ...over,
});

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return 'NO_THROW';
}

describe('activity window', () => {
  it('is open only while published and inside its window', () => {
    expect(isActivityOpen(activity(), NOW)).toBe(true);
    expect(isActivityOpen(activity({ status: 'paused' }), NOW)).toBe(false);
    expect(isActivityOpen(activity({ status: 'draft' }), NOW)).toBe(false);
    expect(isActivityOpen(activity({ deletedAt: NOW }), NOW)).toBe(false);
  });

  it('treats the start as inclusive and the end as exclusive', () => {
    const start = new Date('2026-05-01T00:00:00.000Z');
    const end = new Date('2026-07-01T00:00:00.000Z');
    expect(isActivityOpen(activity(), start)).toBe(true);
    expect(isActivityOpen(activity(), end)).toBe(false);
  });
});

describe('per-order quantity', () => {
  it('is a ceiling on the whole order, not on each line', () => {
    expect(codeOf(() => assertQuantityAllowed({ perOrderQuantity: 2 }, 2))).toBe('NO_THROW');
    expect(codeOf(() => assertQuantityAllowed({ perOrderQuantity: 2 }, 3))).toBe(
      'GROUPBUY_QUANTITY_NOT_ALLOWED',
    );
  });

  it('refuses zero and fractions rather than reading them as 1', () => {
    expect(codeOf(() => assertQuantityAllowed({ perOrderQuantity: 5 }, 0))).toBe(
      'GROUPBUY_QUANTITY_NOT_ALLOWED',
    );
    expect(codeOf(() => assertQuantityAllowed({ perOrderQuantity: 5 }, 1.5))).toBe(
      'GROUPBUY_QUANTITY_NOT_ALLOWED',
    );
  });
});

describe('group shape', () => {
  it('expires ttl seconds after it opens', () => {
    expect(groupExpiresAt(NOW, 86_400).toISOString()).toBe('2026-06-02T12:00:00.000Z');
  });

  it('counts the seats still free', () => {
    expect(seatsLeft(group({ seatsTaken: 1, seatsTotal: 3 }))).toBe(2);
    // Never negative, whatever a counter says.
    expect(seatsLeft(group({ seatsTaken: 5, seatsTotal: 3 }))).toBe(0);
  });

  it('is joinable only while forming, unexpired and not full', () => {
    expect(isGroupJoinable(group(), NOW)).toBe(true);
    expect(isGroupJoinable(group({ seatsTaken: 3 }), NOW)).toBe(false);
    expect(isGroupJoinable(group({ status: 'succeeded' }), NOW)).toBe(false);
    expect(isGroupJoinable(group({ expiresAt: new Date('2026-05-31T00:00:00.000Z') }), NOW)).toBe(
      false,
    );
    expect(codeOf(() => assertGroupJoinable(group({ seatsTaken: 3 }), NOW))).toBe(
      'GROUPBUY_GROUP_NOT_JOINABLE',
    );
  });
});

describe('虚拟成团 detection', () => {
  it('is a succeeded team with fewer real buyers than seats', () => {
    expect(wasVirtuallyFilled({ status: 'succeeded', seatsTotal: 3 }, 1)).toBe(true);
    expect(wasVirtuallyFilled({ status: 'succeeded', seatsTotal: 3 }, 3)).toBe(false);
    // A forming team is short of members by definition; that is not faking.
    expect(wasVirtuallyFilled({ status: 'forming', seatsTotal: 3 }, 1)).toBe(false);
  });
});

describe('withdrawal', () => {
  const leading = { ...group({ seatsTaken: 0 }), leaderUserId: 101 };

  it('is the leader abandoning a team nobody has paid into', () => {
    expect(codeOf(() => assertWithdrawable(leading, 101, NOW))).toBe('NO_THROW');
  });

  it('is refused for a member, a paid-into team and a dead team', () => {
    expect(codeOf(() => assertWithdrawable(leading, 999, NOW))).toBe(
      'GROUPBUY_GROUP_NOT_WITHDRAWABLE',
    );
    expect(codeOf(() => assertWithdrawable({ ...leading, seatsTaken: 1 }, 101, NOW))).toBe(
      'GROUPBUY_GROUP_NOT_WITHDRAWABLE',
    );
    expect(codeOf(() => assertWithdrawable({ ...leading, status: 'failed' }, 101, NOW))).toBe(
      'GROUPBUY_GROUP_NOT_WITHDRAWABLE',
    );
  });
});

describe('立即成团', () => {
  it('needs a forming team with at least one real buyer', () => {
    expect(codeOf(() => assertCompletable(group({ seatsTaken: 1 })))).toBe('NO_THROW');
    expect(codeOf(() => assertCompletable(group({ seatsTaken: 0 })))).toBe(
      'GROUPBUY_GROUP_NOT_COMPLETABLE',
    );
    expect(codeOf(() => assertCompletable(group({ status: 'succeeded', seatsTaken: 3 })))).toBe(
      'GROUPBUY_GROUP_NOT_COMPLETABLE',
    );
  });
});

describe('the activity-price guard', () => {
  const prices = new Map([
    [21, '59.00'],
    [22, '65.50'],
  ]);

  it('sums the activity price times the quantity', () => {
    const total = expectedGoodsTotal(
      [
        { skuId: 21, quantity: 2 },
        { skuId: 22, quantity: 1 },
      ],
      prices,
    );
    expect(total.toString()).toBe('183.50');
  });

  it('refuses a line the activity does not sell', () => {
    expect(codeOf(() => expectedGoodsTotal([{ skuId: 99, quantity: 1 }], prices))).toBe(
      'GROUPBUY_SKU_NOT_IN_ACTIVITY',
    );
  });

  it('fails closed when the order charges the catalogue price', () => {
    // 88.00 is the catalogue price: what the order carries when the pricing
    // contributor never ran.
    expect(
      codeOf(() =>
        assertActivityPriceApplied({
          expected: Money.parse('59.00'),
          charged: Money.parse('88.00'),
          activityId: 1,
        }),
      ),
    ).toBe('GROUPBUY_PRICE_NOT_APPLIED');
  });

  it('is silent once the order charges the activity price', () => {
    expect(
      codeOf(() =>
        assertActivityPriceApplied({
          expected: Money.parse('59.00'),
          charged: Money.parse('59.00'),
          activityId: 1,
        }),
      ),
    ).toBe('NO_THROW');
  });

  it('allows a coupon to take more off on top', () => {
    expect(
      codeOf(() =>
        assertActivityPriceApplied({
          expected: Money.parse('59.00'),
          charged: Money.parse('49.00'),
          activityId: 1,
        }),
      ),
    ).toBe('NO_THROW');
  });

  it('reports both amounts, so the operator can see which layer dropped the price', () => {
    try {
      assertActivityPriceApplied({
        expected: Money.parse('59.00'),
        charged: Money.parse('88.00'),
        activityId: 7,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).details).toEqual({
        activityId: '7',
        expected: '59.00',
        charged: '88.00',
      });
    }
  });
});

/**
 * The earlier half of the same guard, which reads the applied adjustments off
 * the draft instead of the written lines.
 */
describe('assertActivityDiscountApplied', () => {
  it('passes when the contributor took off exactly the gap it owes', () => {
    expect(
      codeOf(() =>
        assertActivityDiscountApplied({
          // 59.00 activity price against an 88.00 catalogue line.
          expected: Money.parse('-29.00'),
          actual: Money.parse('-29.00'),
          activityId: 1,
        }),
      ),
    ).toBe('NO_THROW');
  });

  it('refuses when nothing was taken off at all', () => {
    // No entry on the draft reads as `Money.ZERO`: the contributor was dropped,
    // reordered behind something that overwrote it, or returned `[]`.
    expect(
      codeOf(() =>
        assertActivityDiscountApplied({
          expected: Money.parse('-29.00'),
          actual: Money.ZERO,
          activityId: 1,
        }),
      ),
    ).toBe('GROUPBUY_PRICE_NOT_APPLIED');
  });

  it('refuses an adjustment larger than the gap, not only a smaller one', () => {
    expect(
      codeOf(() =>
        assertActivityDiscountApplied({
          expected: Money.parse('-29.00'),
          actual: Money.parse('-39.00'),
          activityId: 1,
        }),
      ),
    ).toBe('GROUPBUY_PRICE_NOT_APPLIED');
  });

  it('passes a campaign that discounts nothing, because the shopper pays the same', () => {
    expect(
      codeOf(() =>
        assertActivityDiscountApplied({
          expected: Money.ZERO,
          actual: Money.ZERO,
          activityId: 1,
        }),
      ),
    ).toBe('NO_THROW');
  });
});

describe('RISK-D-010 — a team shows strangers a masked nickname', () => {
  it('keeps the first character and one star, whatever the length', () => {
    expect(maskNickname('小明')).toBe('小*');
    expect(maskNickname('小明明明明')).toBe('小*');
    expect(maskNickname('用户8000')).toBe('用*');
    expect(maskNickname('Alice')).toBe('A*');
  });

  it('keeps a whole emoji rather than half a surrogate pair', () => {
    expect(maskNickname('😀开心')).toBe('😀*');
    expect(maskNickname('👍🏽赞')).toBe('👍🏽*');
    expect(maskNickname('👨‍👩‍👧一家')).toBe('👨‍👩‍👧*');
  });

  it('stars out a one-character name entirely', () => {
    expect(maskNickname('明')).toBe('*');
    expect(maskNickname('😀')).toBe('*');
    expect(maskNickname(' 明 ')).toBe('*');
  });

  it('answers null for no name at all', () => {
    expect(maskNickname(null)).toBeNull();
    expect(maskNickname('')).toBeNull();
    expect(maskNickname('   ')).toBeNull();
  });
});
