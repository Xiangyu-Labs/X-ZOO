import { describe, expect, it } from 'vitest';
import { Money, money } from './money';

describe('Money.parse / toString', () => {
  it('round-trips the wire form', () => {
    for (const value of ['0.00', '0.01', '12.00', '12.34', '9999999999.99']) {
      expect(Money.parse(value).toString()).toBe(value);
    }
  });

  it('accepts what PostgreSQL numeric and hand-written seeds produce', () => {
    expect(Money.parse('12').fen).toBe(1200);
    expect(Money.parse('12.5').fen).toBe(1250);
    expect(Money.parse(' 12.50 ').fen).toBe(1250);
    expect(Money.parse('-3.20').fen).toBe(-320);
  });

  it('rejects anything that is not a two-decimal amount', () => {
    for (const bad of ['12.345', '1e3', '12,00', '', 'abc', '.5', '12.', '--1.00']) {
      expect(() => Money.parse(bad), bad).toThrow(TypeError);
    }
  });

  it('serialises to the wire string inside JSON', () => {
    expect(JSON.stringify({ total: Money.parse('8.80') })).toBe('{"total":"8.80"}');
  });

  it('refuses a non-integer fen amount', () => {
    expect(() => Money.fromFen(1.5)).toThrow(TypeError);
  });

  it('refuses amounts wider than numeric(12,2)', () => {
    expect(() => Money.fromFen(1_000_000_000_000)).toThrow(RangeError);
  });
});

describe('Money arithmetic', () => {
  it('adds and subtracts exactly where floats would not', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE754; in fen it is just 10 + 20 = 30.
    expect(Money.parse('0.10').add(Money.parse('0.20')).toString()).toBe('0.30');
    expect(Money.parse('10.00').sub(Money.parse('9.99')).toString()).toBe('0.01');
  });

  it('multiplies by an integer quantity', () => {
    expect(Money.parse('19.90').mul(3).toString()).toBe('59.70');
    expect(() => Money.parse('19.90').mul(1.5)).toThrow(TypeError);
  });

  it('applies a ratio with half-away-from-zero rounding', () => {
    // 88折 on 19.99 = 17.5912 -> 17.59
    expect(Money.parse('19.99').mulRatio(88, 100).toString()).toBe('17.59');
    // exact half rounds away from zero, both signs
    expect(Money.fromFen(5).mulRatio(1, 2).fen).toBe(3);
    expect(Money.fromFen(-5).mulRatio(1, 2).fen).toBe(-3);
    expect(() => Money.parse('1.00').mulRatio(1, 0)).toThrow(RangeError);
  });

  it('sums, clamps and compares', () => {
    expect(Money.sum([Money.parse('1.10'), Money.parse('2.20')]).toString()).toBe('3.30');
    expect(Money.sum([]).toString()).toBe('0.00');
    expect(Money.parse('1.00').sub(Money.parse('3.00')).clampToZero().toString()).toBe('0.00');
    expect(Money.parse('1.00').lt(Money.parse('2.00'))).toBe(true);
    expect(Money.parse('2.00').compare(Money.parse('2.00'))).toBe(0);
    expect(Money.max(Money.parse('1.00'), Money.parse('2.00')).toString()).toBe('2.00');
    expect(Money.min(Money.parse('1.00'), Money.parse('2.00')).toString()).toBe('1.00');
  });

  it('exposes fen for WeChat Pay', () => {
    expect(Money.parse('0.01').valueOfFen()).toBe(1);
  });
});

describe('Money.allocate — a split must never lose or invent a fen', () => {
  it('handles the classic 10.00 across three ways', () => {
    const parts = Money.parse('10.00').allocate([1, 1, 1]);
    expect(parts.map(String)).toEqual(['3.34', '3.33', '3.33']);
    expect(Money.sum(parts).toString()).toBe('10.00');
  });

  it('splits proportionally to line subtotals', () => {
    // A 5.00 discount over lines of 30.00 / 20.00 / 0.01
    const parts = Money.parse('5.00').allocate([3000, 2000, 1]);
    expect(Money.sum(parts).toString()).toBe('5.00');
    expect(parts[0]!.gt(parts[1]!)).toBe(true);
    expect(parts[2]!.fen).toBe(0);
  });

  it('gives the leftover fen to the largest remainders, deterministically', () => {
    const a = Money.fromFen(100).allocate([1, 1, 1]);
    const b = Money.fromFen(100).allocate([1, 1, 1]);
    expect(a.map(String)).toEqual(b.map(String));
    expect(a.map((m) => m.fen)).toEqual([34, 33, 33]);
  });

  it('keeps the sum exact for a thousand random splits', () => {
    let seed = 42;
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    for (let i = 0; i < 1000; i += 1) {
      const total = Money.fromFen(next(1_000_000));
      const weights = Array.from({ length: 1 + next(8) }, () => next(5000));
      const parts = total.allocate(weights);
      expect(parts).toHaveLength(weights.length);
      expect(Money.sum(parts).fen, `total=${total} weights=${weights}`).toBe(total.fen);
    }
  });

  it('spreads evenly when every weight is zero', () => {
    const parts = Money.parse('1.00').allocate([0, 0, 0]);
    expect(parts.map(String)).toEqual(['0.34', '0.33', '0.33']);
  });

  it('preserves the sign of a negative amount', () => {
    const parts = Money.fromFen(-100).allocate([1, 1, 1]);
    expect(parts.map((m) => m.fen)).toEqual([-34, -33, -33]);
    expect(Money.sum(parts).fen).toBe(-100);
  });

  it('returns nothing for no weights and rejects a negative weight', () => {
    expect(Money.parse('1.00').allocate([])).toEqual([]);
    expect(() => Money.parse('1.00').allocate([1, -1])).toThrow(RangeError);
  });

  it('allocateEvenly matches allocate with equal weights', () => {
    expect(
      Money.fromFen(101)
        .allocateEvenly(4)
        .map((m) => m.fen),
    ).toEqual([26, 25, 25, 25]);
    expect(Money.fromFen(101).allocateEvenly(0)).toEqual([]);
    expect(() => Money.fromFen(1).allocateEvenly(-1)).toThrow(RangeError);
  });
});

describe('the money() shorthand', () => {
  it('takes a string or a fen number', () => {
    expect(money('1.00').fen).toBe(100);
    expect(money(100).toString()).toBe('1.00');
    expect(money(Money.ZERO).isZero()).toBe(true);
  });
});
