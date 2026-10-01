import { describe, expect, it } from 'vitest';
import { Money } from '../kernel/money';
import {
  eligibleLineIndexes,
  isClaimWindowOpen,
  isWithinWindow,
  quoteLines,
  windowForIssue,
  type CouponLine,
  type CouponTerms,
  type ValidityTerms,
} from './coupon.rules';

/**
 * The arithmetic half of the coupon domain, tested without Docker.
 *
 * Everything that needs a database is in `coupon.int.test.ts`. The split is
 * deliberate: these run in milliseconds and are the ones that fail first when
 * somebody "simplifies" the discount cap.
 */

const yuan = (value: string) => Money.parse(value);

function line(productId: number, amount: string, categoryIds: number[] = []): CouponLine {
  return { productId, categoryIds, amount: yuan(amount) };
}

function terms(overrides: Partial<CouponTerms> = {}): CouponTerms {
  return {
    scope: 'all_products',
    productIds: [],
    categoryIds: [],
    discountAmount: yuan('10.00'),
    minSpend: Money.ZERO,
    ...overrides,
  };
}

describe('eligibleLineIndexes', () => {
  const lines = [line(1, '10.00', [7]), line(2, '20.00', [8, 9]), line(3, '30.00')];

  it('covers every line for all_products, including a line with no category', () => {
    expect(eligibleLineIndexes(terms(), lines)).toEqual([0, 1, 2]);
  });

  it('covers only the listed products', () => {
    expect(eligibleLineIndexes(terms({ scope: 'products', productIds: [1, 3] }), lines)).toEqual([
      0, 2,
    ]);
  });

  it('covers a line that is in any one of the listed categories', () => {
    expect(eligibleLineIndexes(terms({ scope: 'categories', categoryIds: [9] }), lines)).toEqual([
      1,
    ]);
  });

  it('covers nothing when the scope matches no line', () => {
    expect(eligibleLineIndexes(terms({ scope: 'products', productIds: [99] }), lines)).toEqual([]);
  });

  it('ignores categoryIds on a product-scoped coupon and vice versa', () => {
    const productScoped = terms({ scope: 'products', productIds: [1], categoryIds: [8, 9] });
    expect(eligibleLineIndexes(productScoped, lines)).toEqual([0]);
    const categoryScoped = terms({ scope: 'categories', categoryIds: [7], productIds: [2, 3] });
    expect(eligibleLineIndexes(categoryScoped, lines)).toEqual([0]);
  });
});

describe('quoteLines', () => {
  it('takes the discount off when everything is in scope', () => {
    const outcome = quoteLines(terms({ discountAmount: yuan('10.00') }), [line(1, '100.00')]);
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.discount.toString()).toBe('10.00');
    expect(outcome.eligibleSubtotal.toString()).toBe('100.00');
  });

  it('refuses when no line is in scope', () => {
    const outcome = quoteLines(terms({ scope: 'products', productIds: [42] }), [line(1, '100.00')]);
    expect(outcome).toMatchObject({ ok: false, reason: 'COUPON_NOT_APPLICABLE' });
    expect(outcome.eligibleSubtotal.toString()).toBe('0.00');
  });

  it('refuses an empty cart', () => {
    expect(quoteLines(terms(), [])).toMatchObject({ ok: false, reason: 'COUPON_NOT_APPLICABLE' });
  });

  it('compares min_spend against the ELIGIBLE subtotal, not the whole cart', () => {
    // ¥200 cart, but only ¥30 of it is in category 7. A ¥100 threshold is not met.
    const categoryCoupon = terms({
      scope: 'categories',
      categoryIds: [7],
      minSpend: yuan('100.00'),
    });
    const cart = [line(1, '30.00', [7]), line(2, '170.00', [8])];
    const outcome = quoteLines(categoryCoupon, cart);
    expect(outcome).toMatchObject({ ok: false, reason: 'COUPON_MIN_SPEND_NOT_MET' });
    expect(outcome.eligibleSubtotal.toString()).toBe('30.00');
    // The refusal still reports which lines it looked at, for the picker's tooltip.
    expect(outcome.eligibleLineIndexes).toEqual([0]);
  });

  it('meets min_spend exactly — the threshold is inclusive', () => {
    const outcome = quoteLines(terms({ minSpend: yuan('100.00') }), [line(1, '100.00')]);
    expect(outcome.ok).toBe(true);
  });

  it('caps the discount at the eligible subtotal — a coupon never creates money', () => {
    const outcome = quoteLines(terms({ discountAmount: yuan('50.00') }), [line(1, '30.00')]);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.discount.toString()).toBe('30.00');
  });

  it('caps against the eligible subtotal even when the whole cart is bigger', () => {
    const outcome = quoteLines(
      terms({ scope: 'products', productIds: [1], discountAmount: yuan('50.00') }),
      [line(1, '30.00'), line(2, '500.00')],
    );
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.discount.toString()).toBe('30.00');
  });

  it('sums the eligible lines rather than taking the first', () => {
    const outcome = quoteLines(terms({ scope: 'categories', categoryIds: [7] }), [
      line(1, '10.50', [7]),
      line(2, '5.25', [7]),
      line(3, '999.00', [8]),
    ]);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.eligibleSubtotal.toString()).toBe('15.75');
    expect(outcome.discount.toString()).toBe('10.00');
  });

  it('works in fen, so 0.1 + 0.2 problems cannot happen', () => {
    const outcome = quoteLines(terms({ discountAmount: yuan('0.01') }), [
      line(1, '0.10'),
      line(2, '0.20'),
    ]);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.eligibleSubtotal.toString()).toBe('0.30');
  });
});

describe('windowForIssue', () => {
  const claimedAt = new Date('2026-09-21T10:00:00.000Z');

  it('copies the template dates for fixed_window', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-12-31T23:59:59.000Z');
    const validity: ValidityTerms = {
      validityMode: 'fixed_window',
      validFrom: from,
      validTo: to,
      validDays: null,
    };
    expect(windowForIssue(validity, claimedAt)).toEqual({ from, to });
  });

  it('starts at the claim instant for days_after_claim', () => {
    const validity: ValidityTerms = {
      validityMode: 'days_after_claim',
      validFrom: null,
      validTo: null,
      validDays: 7,
    };
    const window = windowForIssue(validity, claimedAt);
    expect(window.from).toEqual(claimedAt);
    expect(window.to.toISOString()).toBe('2026-09-28T10:00:00.000Z');
  });

  it('throws on a template the CHECK constraint should have rejected', () => {
    expect(() =>
      windowForIssue(
        { validityMode: 'fixed_window', validFrom: null, validTo: null, validDays: null },
        claimedAt,
      ),
    ).toThrow(/fixed_window/);
    expect(() =>
      windowForIssue(
        { validityMode: 'days_after_claim', validFrom: null, validTo: null, validDays: null },
        claimedAt,
      ),
    ).toThrow(/days_after_claim/);
  });
});

describe('isWithinWindow', () => {
  const from = new Date('2026-09-01T00:00:00.000Z');
  const to = new Date('2026-09-30T00:00:00.000Z');

  it('is inclusive at both ends', () => {
    expect(isWithinWindow(from, from, to)).toBe(true);
    expect(isWithinWindow(to, from, to)).toBe(true);
  });

  it('excludes a millisecond either side', () => {
    expect(isWithinWindow(new Date(from.getTime() - 1), from, to)).toBe(false);
    expect(isWithinWindow(new Date(to.getTime() + 1), from, to)).toBe(false);
  });
});

describe('isClaimWindowOpen', () => {
  const now = new Date('2026-09-21T10:00:00.000Z');
  const open = {
    validityMode: 'days_after_claim' as const,
    validFrom: null,
    validTo: null,
    validDays: 7,
    claimFrom: null,
    claimTo: null,
  };

  it('is open when no claim window is set', () => {
    expect(isClaimWindowOpen(open, now)).toBe(true);
  });

  it('is closed before claim_from and after claim_to', () => {
    expect(isClaimWindowOpen({ ...open, claimFrom: new Date('2026-10-01T00:00:00Z') }, now)).toBe(
      false,
    );
    expect(isClaimWindowOpen({ ...open, claimTo: new Date('2026-09-01T00:00:00Z') }, now)).toBe(
      false,
    );
  });

  it('is open on the boundary instants', () => {
    expect(isClaimWindowOpen({ ...open, claimFrom: now, claimTo: now }, now)).toBe(true);
  });

  it('is closed once a fixed_window campaign has already expired', () => {
    // Claim window still open, spending window over: issuing here would hand
    // the shopper a coupon that is dead on arrival.
    const deadOnArrival = {
      validityMode: 'fixed_window' as const,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      validTo: new Date('2026-09-01T00:00:00Z'),
      validDays: null,
      claimFrom: null,
      claimTo: new Date('2026-12-31T00:00:00Z'),
    };
    expect(isClaimWindowOpen(deadOnArrival, now)).toBe(false);
  });

  it('does not apply the expiry rule to days_after_claim', () => {
    expect(isClaimWindowOpen({ ...open, claimTo: new Date('2026-12-31T00:00:00Z') }, now)).toBe(
      true,
    );
  });
});
