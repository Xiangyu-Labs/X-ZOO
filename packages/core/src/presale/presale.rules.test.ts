import { describe, expect, it } from 'vitest';
import { Money } from '../kernel/money';
import {
  assertActivityOpen,
  assertActivityPriceApplied,
  assertFullPayment,
  assertOrderShape,
  canBuy,
  expectedGoodsTotal,
  isActivityOpen,
  isBalanced,
  ledgerBalance,
  releaseDeltas,
  reserveDeltas,
  shipNotBefore,
} from './presale.rules';

/**
 * The presale rules, without a database.
 *
 * Each of these decisions is easy to make in two places with two different
 * answers, so each test names the defect it pins down rather than restating the
 * code.
 */

const AT = new Date('2026-06-01T00:00:00.000Z');

const activity = (over: Partial<Parameters<typeof isActivityOpen>[0]> = {}) => ({
  status: 'active' as const,
  startAt: new Date('2026-05-01T00:00:00.000Z'),
  endAt: new Date('2026-07-01T00:00:00.000Z'),
  deletedAt: null,
  ...over,
});

describe('the sale window', () => {
  it('is open only for a published, undeleted campaign inside its window', () => {
    expect(isActivityOpen(activity(), AT)).toBe(true);
    expect(isActivityOpen(activity({ status: 'paused' }), AT)).toBe(false);
    expect(isActivityOpen(activity({ status: 'draft' }), AT)).toBe(false);
    expect(isActivityOpen(activity({ deletedAt: AT }), AT)).toBe(false);
    expect(isActivityOpen(activity({ startAt: new Date('2026-06-02T00:00:00.000Z') }), AT)).toBe(
      false,
    );
  });

  it('closes on `endAt`, not after it', () => {
    // A window ending at midnight does not sell one more unit at midnight.
    expect(isActivityOpen(activity({ endAt: AT }), AT)).toBe(false);
    expect(isActivityOpen(activity({ endAt: new Date(AT.getTime() + 1) }), AT)).toBe(true);
  });

  it('names what was wrong when it refuses', () => {
    expect(() => assertActivityOpen(activity({ status: 'ended' }), AT)).toThrowError(
      expect.objectContaining({ code: 'PRESALE_ACTIVITY_NOT_OPEN' }),
    );
  });
});

describe('full payment only', () => {
  it('refuses a deposit campaign explicitly rather than half-building one', () => {
    expect(() => assertFullPayment({ paymentMode: 'full' })).not.toThrow();
    expect(() => assertFullPayment({ paymentMode: 'deposit' })).toThrowError(
      expect.objectContaining({ code: 'PRESALE_DEPOSIT_NOT_SUPPORTED' }),
    );
  });

  it('never offers the buy button for a deposit campaign', () => {
    expect(canBuy({ ...activity(), stock: 10, paymentMode: 'full' }, AT)).toBe(true);
    expect(canBuy({ ...activity(), stock: 10, paymentMode: 'deposit' }, AT)).toBe(false);
    expect(canBuy({ ...activity(), stock: 0, paymentMode: 'full' }, AT)).toBe(false);
  });
});

describe('the shape of a presale order', () => {
  it('accepts exactly one line', () => {
    expect(() =>
      assertOrderShape({ perOrderQuantity: 5 }, [{ skuId: 1, quantity: 2 }]),
    ).not.toThrow();
    expect(() =>
      assertOrderShape({ perOrderQuantity: 5 }, [
        { skuId: 1, quantity: 1 },
        { skuId: 2, quantity: 1 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'PRESALE_QUANTITY_NOT_ALLOWED' }));
    expect(() => assertOrderShape({ perOrderQuantity: 5 }, [])).toThrowError(
      expect.objectContaining({ code: 'PRESALE_QUANTITY_NOT_ALLOWED' }),
    );
  });

  it('caps the quantity at `perOrderQuantity` inclusively', () => {
    // `>` in one place and `>=` in another would make 限购 5 sometimes mean 4.
    expect(() =>
      assertOrderShape({ perOrderQuantity: 5 }, [{ skuId: 1, quantity: 5 }]),
    ).not.toThrow();
    expect(() =>
      assertOrderShape({ perOrderQuantity: 5 }, [{ skuId: 1, quantity: 6 }]),
    ).toThrowError(expect.objectContaining({ code: 'PRESALE_QUANTITY_NOT_ALLOWED' }));
    expect(() =>
      assertOrderShape({ perOrderQuantity: 5 }, [{ skuId: 1, quantity: 0 }]),
    ).toThrowError(expect.objectContaining({ code: 'PRESALE_QUANTITY_NOT_ALLOWED' }));
  });
});

describe('the price guard', () => {
  const prices = new Map([
    [31, '128.00'],
    [32, '148.00'],
  ]);

  it('sums the campaign price times the quantity', () => {
    expect(expectedGoodsTotal([{ skuId: 31, quantity: 3 }], prices).toString()).toBe('384.00');
  });

  it('refuses a SKU the campaign does not sell before doing any arithmetic', () => {
    expect(() => expectedGoodsTotal([{ skuId: 99, quantity: 1 }], prices)).toThrowError(
      expect.objectContaining({ code: 'PRESALE_SKU_NOT_IN_ACTIVITY' }),
    );
  });

  it('fails closed when the draft still carries the catalogue price', () => {
    expect(() =>
      assertActivityPriceApplied({
        expected: Money.parse('128.00'),
        actual: Money.parse('168.00'),
        activityId: 2,
      }),
    ).toThrowError(expect.objectContaining({ code: 'PRESALE_PRICE_NOT_APPLIED' }));

    expect(() =>
      assertActivityPriceApplied({
        expected: Money.parse('128.00'),
        actual: Money.parse('128.00'),
        activityId: 2,
      }),
    ).not.toThrow();
  });
});

describe('the 发货承诺', () => {
  it('counts from payment, in whole days', () => {
    expect(shipNotBefore(new Date('2026-09-22T03:05:00.000Z'), 15).toISOString()).toBe(
      '2026-10-07T03:05:00.000Z',
    );
  });

  it('is the payment instant itself when the campaign promises no delay', () => {
    const at = new Date('2026-09-22T03:05:00.000Z');
    expect(shipNotBefore(at, 0).getTime()).toBe(at.getTime());
  });
});

describe('the four ledgers (REFUND-002)', () => {
  it('records a reservation as stock down on both layers and no sale yet', () => {
    expect(reserveDeltas(3)).toEqual({
      activityStockDelta: -3,
      activitySalesDelta: 0,
      productStockDelta: -3,
      productSalesDelta: 0,
    });
  });

  it('walks `sales` back only when the reservation had become a sale', () => {
    expect(releaseDeltas(3, false)).toEqual({
      activityStockDelta: 3,
      activitySalesDelta: 0,
      productStockDelta: 3,
      productSalesDelta: 0,
    });
    expect(releaseDeltas(3, true)).toEqual({
      activityStockDelta: 3,
      activitySalesDelta: -3,
      productStockDelta: 3,
      productSalesDelta: -3,
    });
  });

  it('balances a cancel and a refund to exactly zero on all four columns', () => {
    expect(isBalanced([reserveDeltas(3), releaseDeltas(3, false)])).toBe(true);
    // A paid order's reservation became a sale, so the `sales` columns only
    // balance once the sale itself is accounted for — which is what the
    // integration test reads off the real counters.
    expect(ledgerBalance([reserveDeltas(3), releaseDeltas(3, true)])).toEqual({
      activityStockDelta: 0,
      activitySalesDelta: -3,
      productStockDelta: 0,
      productSalesDelta: -3,
    });
  });

  it('is unbalanced when a release goes missing', () => {
    expect(isBalanced([reserveDeltas(3)])).toBe(false);
  });
});
