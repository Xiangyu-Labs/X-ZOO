'use client';

import { LinkOutlined } from '@ant-design/icons';
import { ColorPicker, Input, InputNumber, Space } from 'antd';

import type { ConfigFieldUnit } from './types';

/**
 * The controls `<ConfigGroupForm>` adds on top of plain antd inputs. Each one
 * is a controlled `value` / `onChange` pair, so `<Form.Item>` drives it like
 * any input and the saved shape never changes: a colour is still `#RRGGBB`, a
 * size is still bytes.
 */

const SWATCHES = [
  '#E93323',
  '#E1251B',
  '#FF5000',
  '#FF9C00',
  '#07C160',
  '#1890FF',
  '#722ED1',
  '#282828',
  '#666666',
  '#FFFFFF',
];

/**
 * `#RRGGBB`, upper-case, or `''` when cleared.
 *
 * Upper-case because the stored defaults are (`#E93323`), so picking the same
 * colour back does not count as a change. No alpha: the mini-program's tab-bar
 * API takes `#RRGGBB` and nothing else.
 */
export function ColorField({
  id,
  value,
  onChange,
  disabled,
  allowClear,
  placeholder,
}: {
  /** Injected by `<Form.Item>` so the label points at the input. */
  id?: string | undefined;
  value?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
  disabled?: boolean | undefined;
  allowClear?: boolean | undefined;
  placeholder?: string | undefined;
}) {
  const hex = typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : undefined;
  return (
    <Space.Compact style={{ width: '100%' }}>
      <ColorPicker
        {...(hex === undefined ? {} : { value: hex })}
        disabled={disabled === true}
        disabledAlpha
        allowClear={allowClear === true}
        format="hex"
        presets={[{ label: '常用', colors: SWATCHES }]}
        onChange={(color) => {
          if ((color as { cleared?: boolean }).cleared) onChange?.('');
          else onChange?.(color.toHexString().toUpperCase());
        }}
        onClear={() => onChange?.('')}
      />
      <Input
        {...(id === undefined ? {} : { id })}
        value={value ?? ''}
        disabled={disabled === true}
        placeholder={placeholder ?? '#RRGGBB'}
        maxLength={7}
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
        onChange={(event) => onChange?.(event.target.value.trim().toUpperCase())}
      />
    </Space.Compact>
  );
}

const UNIT_SUFFIX: Record<ConfigFieldUnit, string> = {
  seconds: '秒',
  minutes: '分钟',
  hours: '小时',
  days: '天',
  ms: '毫秒',
  bytes: 'MB',
  items: '条',
};

const MB = 1024 * 1024;

/**
 * A number with its unit as a suffix. `bytes` is shown and typed in MB (two
 * decimals) and handed back in whole bytes, so nobody has to type 10485760.
 */
export function UnitNumberInput({
  id,
  value,
  onChange,
  unit,
  min,
  disabled,
  placeholder,
}: {
  id?: string | undefined;
  value?: number | null | undefined;
  onChange?: ((value: number | null) => void) | undefined;
  unit: ConfigFieldUnit;
  min?: number | undefined;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
}) {
  const bytes = unit === 'bytes';
  const shown = value === undefined || value === null ? null : bytes ? value / MB : value;
  return (
    <InputNumber<number>
      {...(id === undefined ? {} : { id })}
      style={{ width: '100%' }}
      value={shown}
      disabled={disabled === true}
      suffix={UNIT_SUFFIX[unit]}
      {...(bytes ? { precision: 2, step: 1 } : {})}
      {...(min === undefined ? {} : { min: bytes ? min / MB : min })}
      {...(placeholder === undefined ? {} : { placeholder })}
      onChange={(next) => onChange?.(next === null ? null : bytes ? Math.round(next * MB) : next)}
    />
  );
}

/** A URL box with a link to open what is typed, so a typo shows up as a 404. */
export function UrlInput({
  id,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  /** Injected by `<Form.Item>` so the label points at the input. */
  id?: string | undefined;
  value?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
}) {
  const openable = typeof value === 'string' && /^https?:\/\//.test(value);
  return (
    <Input
      {...(id === undefined ? {} : { id })}
      value={value ?? ''}
      disabled={disabled === true}
      placeholder={placeholder ?? 'https://'}
      allowClear
      onChange={(event) => onChange?.(event.target.value)}
      suffix={
        openable ? (
          <a href={value} target="_blank" rel="noreferrer noopener" aria-label="打开链接">
            <LinkOutlined />
          </a>
        ) : (
          <span />
        )
      }
    />
  );
}
