'use client';

import { Tooltip } from 'antd';

import { formatInstant, type InstantFormat } from './instant';

export interface InstantTextProps {
  /** ISO-8601 instant with offset, as contracts carry it. */
  value: string | null | undefined;
  /** Default `'datetime'`. `'relative'` shows "3 小时前" with the exact time on hover. */
  format?: InstantFormat | undefined;
  /** Shown when `value` is absent. Default `—`. */
  placeholder?: string | undefined;
  /** Force the hover tooltip on/off. Default: on for `relative`, off otherwise. */
  tooltip?: boolean | undefined;
}

/** Renders an instant in Asia/Shanghai, consistently, everywhere. */
export function InstantText({
  value,
  format = 'datetime',
  placeholder = '—',
  tooltip,
}: InstantTextProps) {
  const text = formatInstant(value, format, placeholder);
  const showTooltip = tooltip ?? format === 'relative';
  if (!value || !showTooltip) return <span>{text}</span>;
  return (
    <Tooltip title={formatInstant(value, 'datetime', placeholder)}>
      <span>{text}</span>
    </Tooltip>
  );
}
