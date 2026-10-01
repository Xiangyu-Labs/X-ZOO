import { describe, expect, it } from 'vitest';
import { fromCents, strikePrice, toCents } from './money';

describe('money', () => {
  it('strikes a 划线价 only when it is above the price', () => {
    expect(strikePrice('59.90', '88.00')).toBe('88.00');
    expect(strikePrice('59.90', '59.90')).toBeNull();
    expect(strikePrice('59.90', '39.00')).toBeNull();
    expect(strikePrice('59.90', null)).toBeNull();
    expect(strikePrice('100', '99.99')).toBeNull();
  });

  it('does money in cents', () => {
    expect(toCents('12.3')).toBe(1230);
    expect(toCents('0.07')).toBe(7);
    expect(toCents('199')).toBe(19900);
    expect(toCents('-1.50')).toBe(-150);
    expect(fromCents(905)).toBe('9.05');
    expect(fromCents(0)).toBe('0.00');
    expect(fromCents(-150)).toBe('-1.50');
  });
});
