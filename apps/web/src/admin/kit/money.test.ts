import { describe, expect, it } from 'vitest';

import {
  addMoney,
  fenToMoney,
  formatMoney,
  isMoney,
  moneyToFen,
  multiplyMoney,
  normaliseMoney,
} from './money';

describe('normaliseMoney', () => {
  it('pads to exactly two decimals', () => {
    expect(normaliseMoney('12')).toBe('12.00');
    expect(normaliseMoney('12.3')).toBe('12.30');
    expect(normaliseMoney('12.34')).toBe('12.34');
    expect(normaliseMoney('0')).toBe('0.00');
  });

  it('truncates rather than rounds, so no cent is invented', () => {
    expect(normaliseMoney('12.999')).toBe('12.99');
  });

  it('strips leading zeros and surrounding space', () => {
    expect(normaliseMoney('  007.5 ')).toBe('7.50');
    expect(normaliseMoney('0.5')).toBe('0.50');
  });

  it('keeps a negative sign', () => {
    expect(normaliseMoney('-3.5')).toBe('-3.50');
  });

  it('returns undefined for empty and malformed input', () => {
    expect(normaliseMoney('')).toBeUndefined();
    expect(normaliseMoney('   ')).toBeUndefined();
    expect(normaliseMoney(null)).toBeUndefined();
    expect(normaliseMoney(undefined)).toBeUndefined();
    expect(normaliseMoney('12元')).toBeUndefined();
  });

  it('accepts a number without ever going through float formatting', () => {
    expect(normaliseMoney(12)).toBe('12.00');
  });
});

describe('isMoney', () => {
  it('only accepts the wire shape', () => {
    expect(isMoney('12.00')).toBe(true);
    expect(isMoney('-12.00')).toBe(true);
    expect(isMoney('12.0')).toBe(false);
    expect(isMoney('12')).toBe(false);
    expect(isMoney(12)).toBe(false);
  });
});

describe('fen conversion', () => {
  it('round-trips through integer fen', () => {
    expect(moneyToFen('12.34')).toBe(1234n);
    expect(moneyToFen('-0.01')).toBe(-1n);
    expect(fenToMoney(1234n)).toBe('12.34');
    expect(fenToMoney(-1n)).toBe('-0.01');
    expect(fenToMoney(0n)).toBe('0.00');
    expect(fenToMoney(5n)).toBe('0.05');
  });

  it('throws on a value that is not money', () => {
    expect(() => moneyToFen('abc')).toThrow('不是合法的金额');
  });

  it('survives amounts beyond Number.MAX_SAFE_INTEGER fen', () => {
    expect(fenToMoney(90071992547409911n)).toBe('900719925474099.11');
  });
});

describe('arithmetic', () => {
  it('adds without float error', () => {
    // 0.1 + 0.2 as floats is 0.30000000000000004.
    expect(addMoney('0.10', '0.20')).toBe('0.30');
    expect(addMoney('19.99', '0.01', '80.00')).toBe('100.00');
  });

  it('multiplies by an integer quantity only', () => {
    expect(multiplyMoney('19.99', 3)).toBe('59.97');
    expect(() => multiplyMoney('19.99', 1.5)).toThrow('金额只能乘以整数');
  });
});

describe('formatMoney', () => {
  it('groups thousands and keeps two decimals', () => {
    expect(formatMoney('1234.50')).toBe('¥1,234.50');
    expect(formatMoney('1234567.05')).toBe('¥1,234,567.05');
    expect(formatMoney('999.00')).toBe('¥999.00');
  });

  it('honours symbol and grouping options', () => {
    expect(formatMoney('1234.50', { symbol: '' })).toBe('1,234.50');
    expect(formatMoney('1234.50', { grouped: false })).toBe('¥1234.50');
  });

  it('puts the sign before the symbol', () => {
    expect(formatMoney('-12.00')).toBe('-¥12.00');
  });

  it('shows a dash for an unusable value', () => {
    expect(formatMoney('')).toBe('—');
    expect(formatMoney('nope')).toBe('—');
  });
});
