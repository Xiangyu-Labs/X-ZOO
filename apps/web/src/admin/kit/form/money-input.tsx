'use client';

import { Input } from 'antd';
import { useState } from 'react';

import { normaliseMoney } from '../money';
import { defined } from '../props';

export interface MoneyInputProps {
  /** Decimal money string, e.g. `"12.00"`. `undefined` = empty. */
  value?: string | undefined;
  onChange?: (value: string | undefined) => void;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  /** Currency prefix. Default `¥`. */
  symbol?: string | undefined;
  /** Allow negative amounts (refund adjustments). Default `false`. */
  allowNegative?: boolean | undefined;
  size?: 'small' | 'middle' | 'large' | undefined;
  style?: React.CSSProperties | undefined;
  id?: string | undefined;
  onBlur?: (() => void) | undefined;
}

/**
 * Money input that is a *string* in and a *string* out — `"12.00"`, never a
 * float. The operator can type freely; the value is normalised to two decimals
 * on blur. No `Number` ever touches the amount.
 *
 * ```tsx
 * { kind: 'money', name: 'price', label: '售价' }
 * ```
 */
export function MoneyInput({
  value,
  onChange,
  placeholder = '0.00',
  disabled = false,
  symbol = '¥',
  allowNegative = false,
  size,
  style,
  id,
  onBlur,
}: MoneyInputProps) {
  const [raw, setRaw] = useState(value ?? '');

  // Derived, not synchronised: while the operator's raw text still normalises to
  // the committed value we show the raw text (so `"12."` survives a keystroke);
  // when the value changes from outside (form reset, record loaded) the raw text
  // is simply no longer what we render. No effect, no cascading render.
  const text = normaliseMoney(raw) === value ? raw : (value ?? '');

  const pattern = allowNegative ? /^-?\d*(\.\d{0,2})?$/ : /^\d*(\.\d{0,2})?$/;

  return (
    <Input
      {...defined({ id, size, style })}
      value={text}
      disabled={disabled}
      prefix={symbol}
      inputMode="decimal"
      placeholder={placeholder}
      onChange={(event) => {
        const next = event.target.value.trim();
        if (next !== '' && !pattern.test(next)) return;
        setRaw(next);
        // Emit only well-formed intermediate values; `"12."` stays local.
        if (next === '') onChange?.(undefined);
        else if (/^-?\d+(\.\d{1,2})?$/.test(next)) onChange?.(normaliseMoney(next));
      }}
      onBlur={() => {
        const normalised = normaliseMoney(text);
        setRaw(normalised ?? '');
        onChange?.(normalised);
        onBlur?.();
      }}
    />
  );
}
