/**
 * Money helpers for the admin UI.
 *
 * Money crosses the wire as a decimal string with exactly two fraction digits
 * ("12.00"). Nothing here ever converts to `number`: every arithmetic step goes
 * through integer fen as `bigint`, so 0.1 + 0.2 can never happen.
 */

const MONEY_RE = /^-?(0|[1-9]\d*)\.\d{2}$/;

export function isMoney(value: unknown): value is string {
  return typeof value === 'string' && MONEY_RE.test(value);
}

/** `"12"` / `"12.3"` / `"  12.345 "` → `"12.00"` / `"12.30"` / `"12.34"` (truncating). */
export function normaliseMoney(input: string | number | null | undefined): string | undefined {
  if (input === null || input === undefined) return undefined;
  const raw = String(input).trim();
  if (raw === '') return undefined;
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match) return undefined;
  const sign = match[1] ?? '';
  const whole = (match[2] ?? '').replace(/^0+(?=\d)/, '') || '0';
  const frac = (match[3] ?? '').slice(0, 2).padEnd(2, '0');
  return `${sign}${whole}.${frac}`;
}

/** Decimal string → integer fen. Throws on a value that is not money-shaped. */
export function moneyToFen(value: string): bigint {
  const normalised = normaliseMoney(value);
  if (!normalised || !isMoney(normalised)) throw new Error(`不是合法的金额：${value}`);
  const negative = normalised.startsWith('-');
  const digits = normalised.replace('-', '').replace('.', '');
  const fen = BigInt(digits);
  return negative ? -fen : fen;
}

export function fenToMoney(fen: bigint): string {
  const negative = fen < 0n;
  const abs = negative ? -fen : fen;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}

export function addMoney(...values: string[]): string {
  return fenToMoney(values.reduce((sum, value) => sum + moneyToFen(value), 0n));
}

export function multiplyMoney(value: string, times: number | bigint): string {
  if (typeof times === 'number' && !Number.isInteger(times)) {
    throw new Error('金额只能乘以整数，避免浮点误差');
  }
  return fenToMoney(moneyToFen(value) * BigInt(times));
}

export interface FormatMoneyOptions {
  /** Default `'¥'`. Pass `''` for a bare number. */
  symbol?: string | undefined;
  /** Thousands separators. Default `true`. */
  grouped?: boolean | undefined;
}

/** `"1234.50"` → `"¥1,234.50"`. Display only; never feed the result back in. */
export function formatMoney(value: string, options: FormatMoneyOptions = {}): string {
  const { symbol = '¥', grouped = true } = options;
  const normalised = normaliseMoney(value);
  if (!normalised) return '—';
  const negative = normalised.startsWith('-');
  const [whole = '0', frac = '00'] = normalised.replace('-', '').split('.');
  const groupedWhole = grouped ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole;
  return `${negative ? '-' : ''}${symbol}${groupedWhole}.${frac}`;
}
