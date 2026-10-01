/**
 * Money, as integer 分 (fen).
 *
 * `docs/conventions.md`: "integer fen inside the domain via `Money`; never
 * floats". On the wire and in `numeric(12,2)` money is the decimal string
 * `"12.00"`; inside the domain it is this immutable value object.
 *
 * The only interesting operation is `allocate`, which splits an amount across
 * weights without ever losing or inventing a fen — the thing an order discount
 * split gets wrong in every codebase that does it with floats.
 */

const FEN_PER_YUAN = 100;
/** numeric(12,2) holds ten integer digits, i.e. 9_999_999_999.99 yuan. */
const MAX_FEN = 999_999_999_999;

function assertSafeFen(fen: number, what: string): number {
  if (!Number.isInteger(fen)) throw new TypeError(`${what}: 金额必须是整数分，收到 ${fen}`);
  if (Math.abs(fen) > MAX_FEN) throw new RangeError(`${what}: 金额超出 numeric(12,2) 范围`);
  return fen;
}

/** Round half away from zero — what a Chinese shop's arithmetic is expected to do. */
function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export class Money {
  /** Integer 分. */
  readonly fen: number;

  private constructor(fen: number) {
    this.fen = fen;
  }

  static readonly ZERO = new Money(0);

  static fromFen(fen: number): Money {
    return new Money(assertSafeFen(fen, 'Money.fromFen'));
  }

  /** Convenience for literals in tests and seeds: `Money.fromYuan(12)` === `"12.00"`. */
  static fromYuan(yuan: number): Money {
    if (!Number.isFinite(yuan)) throw new TypeError('Money.fromYuan: 金额必须是有限数');
    return new Money(assertSafeFen(roundHalfUp(yuan * FEN_PER_YUAN), 'Money.fromYuan'));
  }

  /**
   * Parses the wire / `numeric(12,2)` form. Accepts an optional sign, and
   * zero, one or two fraction digits ( `"12"`, `"12.0"`, `"12.00"` ) because
   * PostgreSQL's numeric output and hand-written seeds both occur; it does
   * *not* accept a float, exponent form, or more than two fraction digits.
   */
  static parse(value: string | Money): Money {
    if (value instanceof Money) return value;
    if (typeof value !== 'string') throw new TypeError('Money.parse: 需要字符串');
    const m = /^(-?)(\d{1,10})(?:\.(\d{1,2}))?$/.exec(value.trim());
    if (!m) throw new TypeError(`Money.parse: 金额格式不正确 "${value}"`);
    const [, sign, whole, fraction = ''] = m;
    const fen = Number(whole) * FEN_PER_YUAN + Number(fraction.padEnd(2, '0'));
    return new Money(assertSafeFen(sign === '-' ? -fen : fen, 'Money.parse'));
  }

  /** `null`/`undefined`/`''` become zero. Use where a nullable column is read. */
  static parseOrZero(value: string | Money | null | undefined): Money {
    if (value === null || value === undefined || value === '') return Money.ZERO;
    return Money.parse(value);
  }

  static sum(values: readonly Money[]): Money {
    let fen = 0;
    for (const v of values) fen += v.fen;
    return new Money(assertSafeFen(fen, 'Money.sum'));
  }

  static min(a: Money, b: Money): Money {
    return a.fen <= b.fen ? a : b;
  }

  static max(a: Money, b: Money): Money {
    return a.fen >= b.fen ? a : b;
  }

  add(other: Money): Money {
    return new Money(assertSafeFen(this.fen + other.fen, 'Money.add'));
  }

  sub(other: Money): Money {
    return new Money(assertSafeFen(this.fen - other.fen, 'Money.sub'));
  }

  /** Quantity multiplication. Integers only — a "1.5 × price" is a ratio, use `mulRatio`. */
  mul(times: number): Money {
    if (!Number.isInteger(times)) {
      throw new TypeError('Money.mul: 只接受整数倍数，比例请用 mulRatio');
    }
    return new Money(assertSafeFen(this.fen * times, 'Money.mul'));
  }

  /**
   * Multiplies by `numerator / denominator`, rounding half away from zero.
   * A 88折 discount is `mulRatio(88, 100)`, never `* 0.88`.
   */
  mulRatio(numerator: number, denominator: number): Money {
    if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
      throw new TypeError('Money.mulRatio: 比例必须是整数');
    }
    if (denominator === 0) throw new RangeError('Money.mulRatio: 分母不能为 0');
    return new Money(
      assertSafeFen(roundHalfUp((this.fen * numerator) / denominator), 'Money.mulRatio'),
    );
  }

  negate(): Money {
    return new Money(-this.fen);
  }

  abs(): Money {
    return this.fen < 0 ? new Money(-this.fen) : this;
  }

  /** Clamps to zero. `orderTotal.sub(discount).clampToZero()` is the usual use. */
  clampToZero(): Money {
    return this.fen < 0 ? Money.ZERO : this;
  }

  /**
   * Splits this amount across `weights` so that the parts sum back *exactly*
   * to this amount. Uses the largest-remainder method: everyone gets the floor
   * of their share, then the leftover fen go one each to the largest
   * remainders (ties broken by original order, so the result is deterministic).
   *
   * This is how a whole-order discount is pushed down onto order items. If
   * every weight is zero the amount is spread as evenly as possible instead,
   * because "zero-priced items still need the discount attributed somewhere"
   * is the behaviour refunds depend on.
   *
   * @example
   * Money.parse('10.00').allocate([1, 1, 1]) // 3.34, 3.33, 3.33
   */
  allocate(weights: readonly number[]): Money[] {
    if (weights.length === 0) return [];
    for (const w of weights) {
      if (!Number.isFinite(w) || w < 0)
        throw new RangeError('Money.allocate: 权重必须是非负有限数');
    }
    const total = weights.reduce((a, b) => a + b, 0);
    if (total === 0) return this.allocateEvenly(weights.length);

    const sign = this.fen < 0 ? -1 : 1;
    const amount = Math.abs(this.fen);

    const shares = weights.map((weight, index) => {
      const exact = (amount * weight) / total;
      const floor = Math.floor(exact);
      return { index, floor, remainder: exact - floor };
    });
    let left = amount - shares.reduce((a, s) => a + s.floor, 0);
    // Deterministic: bigger remainder first, earlier index wins a tie.
    const order = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (const share of order) {
      if (left <= 0) break;
      share.floor += 1;
      left -= 1;
    }
    return shares.map((s) => new Money(sign * s.floor));
  }

  /** `allocate` with equal weights; the first parts get the leftover fen. */
  allocateEvenly(parts: number): Money[] {
    if (!Number.isInteger(parts) || parts < 0) {
      throw new RangeError('Money.allocateEvenly: 份数必须是非负整数');
    }
    if (parts === 0) return [];
    const sign = this.fen < 0 ? -1 : 1;
    const amount = Math.abs(this.fen);
    const base = Math.floor(amount / parts);
    let left = amount - base * parts;
    return Array.from({ length: parts }, () => {
      const extra = left > 0 ? 1 : 0;
      left -= extra;
      return new Money(sign * (base + extra));
    });
  }

  isZero(): boolean {
    return this.fen === 0;
  }

  isNegative(): boolean {
    return this.fen < 0;
  }

  isPositive(): boolean {
    return this.fen > 0;
  }

  eq(other: Money): boolean {
    return this.fen === other.fen;
  }

  lt(other: Money): boolean {
    return this.fen < other.fen;
  }

  lte(other: Money): boolean {
    return this.fen <= other.fen;
  }

  gt(other: Money): boolean {
    return this.fen > other.fen;
  }

  gte(other: Money): boolean {
    return this.fen >= other.fen;
  }

  compare(other: Money): -1 | 0 | 1 {
    return this.fen < other.fen ? -1 : this.fen > other.fen ? 1 : 0;
  }

  /** The wire / column form, always two fraction digits. */
  toString(): string {
    const sign = this.fen < 0 ? '-' : '';
    const abs = Math.abs(this.fen);
    return `${sign}${Math.floor(abs / FEN_PER_YUAN)}.${String(abs % FEN_PER_YUAN).padStart(2, '0')}`;
  }

  /** So `JSON.stringify({ total: money })` produces `"12.00"` and not `{}`. */
  toJSON(): string {
    return this.toString();
  }

  /** For WeChat Pay, which takes an integer amount in fen. */
  valueOfFen(): number {
    return this.fen;
  }
}

/** Shorthand for the common `Money.parse` at a repo boundary. */
export const money = (value: string | number | Money): Money =>
  typeof value === 'number' ? Money.fromFen(value) : Money.parse(value);
