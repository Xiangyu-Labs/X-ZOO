'use client';

import { formatMoney } from './money';

export interface MoneyTextProps {
  /** Decimal money string from a contract, e.g. `"1234.50"`. */
  value: string | null | undefined;
  /** Currency symbol. Default `¥`; pass `''` for a bare number. */
  symbol?: string | undefined;
  /** Thousands separators. Default `true`. */
  grouped?: boolean | undefined;
  /** Colour negative amounts red and positive ones green. Default `false`. */
  colored?: boolean | undefined;
  placeholder?: string | undefined;
  strong?: boolean | undefined;
}

/** Displays a money string. Never does float math — see `kit/money.ts`. */
export function MoneyText({
  value,
  symbol = '¥',
  grouped = true,
  colored = false,
  placeholder = '—',
  strong = false,
}: MoneyTextProps) {
  if (value === null || value === undefined || value === '') return <span>{placeholder}</span>;
  const text = formatMoney(value, { symbol, grouped });
  const negative = value.startsWith('-');
  const style: React.CSSProperties = {
    fontVariantNumeric: 'tabular-nums',
    ...(strong ? { fontWeight: 600 } : {}),
    ...(colored ? { color: negative ? 'var(--ant-color-error)' : 'var(--ant-color-success)' } : {}),
  };
  return <span style={style}>{text}</span>;
}
