import { MAX_ID_DIGITS, ORDER_NO_LENGTH, orderRef } from '@shop/contracts/order/order.ref.schemas';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '../kernel/clock';
import { generateOrderNo, generateOutTradeNo } from '../kernel/ids';
import { isOrderNo } from './order.ref';

/**
 * The assertion the order reference rests on: **an order number is never
 * mistakable for an order id**, so one `:id` parameter can carry either without
 * a discriminator and without a "try one, then the other" fallback.
 */

describe('order references cannot collide', () => {
  it('every generated order number is exactly ORDER_NO_LENGTH digits', () => {
    const clock = fixedClock('2026-02-01T02:00:00.000Z');
    for (let i = 0; i < 2000; i += 1) {
      // Walk the clock so the time prefix, the wrapping counter and the random
      // tail are all exercised, including the single-digit month/day/hour
      // paddings that a naive concatenation would shorten.
      clock.set(new Date(Date.UTC(2026, i % 12, (i % 28) + 1, i % 24, i % 60, i % 60)));
      const no = generateOrderNo(clock);
      expect(no).toMatch(/^\d+$/);
      expect(no).toHaveLength(ORDER_NO_LENGTH);
    }
  });

  it('a bigint primary key can never be that long', () => {
    // `orders.id` is `bigint generated always as identity`; the largest value
    // the type can hold is 9223372036854775807, which is MAX_ID_DIGITS digits.
    expect(String(2n ** 63n - 1n)).toHaveLength(MAX_ID_DIGITS);
    expect(MAX_ID_DIGITS).toBeLessThan(ORDER_NO_LENGTH);
    // And `fromId` refuses anything past Number.MAX_SAFE_INTEGER, 16 digits,
    // long before the type's ceiling.
    expect(String(Number.MAX_SAFE_INTEGER).length).toBeLessThan(ORDER_NO_LENGTH);
  });

  it('isOrderNo splits the two without looking at the database', () => {
    const clock = fixedClock('2026-02-01T02:00:00.000Z');
    expect(isOrderNo(generateOrderNo(clock))).toBe(true);
    expect(isOrderNo('1')).toBe(false);
    expect(isOrderNo('9001')).toBe(false);
    expect(isOrderNo(String(Number.MAX_SAFE_INTEGER))).toBe(false);
    expect(isOrderNo(String(2n ** 63n - 1n))).toBe(false);
  });

  it("an out_trade_no is not an order reference — it carries a 'P'", () => {
    const clock = fixedClock('2026-02-01T02:00:00.000Z');
    const outTradeNo = generateOutTradeNo(clock);
    expect(outTradeNo.startsWith('P')).toBe(true);
    expect(orderRef.safeParse(outTradeNo).success).toBe(false);
  });
});

describe('orderRef', () => {
  it('accepts an id and an order number', () => {
    expect(orderRef.safeParse('9001').success).toBe(true);
    expect(orderRef.safeParse('202602011000000010123456').success).toBe(true);
  });

  it('refuses everything else', () => {
    for (const bad of [
      '',
      '0',
      '0123',
      '-1',
      '12.0',
      ' 9001',
      '9001 ',
      'abc',
      // One digit past an order number: neither an id nor a number.
      '2026020110000000101234567',
    ]) {
      expect(orderRef.safeParse(bad).success, bad).toBe(false);
    }
  });
});
