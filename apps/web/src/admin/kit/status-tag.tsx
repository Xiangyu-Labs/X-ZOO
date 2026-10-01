'use client';

import { Tag } from 'antd';
import type { ReactNode } from 'react';

/** antd preset colours plus any custom hex. */
export type StatusColor =
  | 'default'
  | 'success'
  | 'processing'
  | 'error'
  | 'warning'
  | 'magenta'
  | 'red'
  | 'volcano'
  | 'orange'
  | 'gold'
  | 'lime'
  | 'green'
  | 'cyan'
  | 'blue'
  | 'geekblue'
  | 'purple'
  | (string & {});

export interface StatusOption {
  label: string;
  color?: StatusColor | undefined;
  icon?: ReactNode | undefined;
}

/**
 * A domain's enum rendered as label + colour. Declare one per enum next to the
 * pages that use it and share it between the table column, the filter bar and
 * the detail view so they can never disagree.
 *
 * ```ts
 * export const ORDER_STATUS: StatusMap = {
 *   unpaid:  { label: '待付款', color: 'warning' },
 *   paid:    { label: '待发货', color: 'processing' },
 *   done:    { label: '已完成', color: 'success' },
 *   cancelled: { label: '已取消', color: 'default' },
 * };
 * ```
 */
export type StatusMap<K extends string = string> = Record<K, StatusOption>;

export interface StatusTagProps<K extends string = string> {
  value: K | null | undefined;
  map: StatusMap<K>;
  /** Shown when `value` is absent or unknown. Default: the raw value, then `—`. */
  placeholder?: string | undefined;
  bordered?: boolean | undefined;
}

export function StatusTag<K extends string = string>({
  value,
  map,
  placeholder,
  bordered = false,
}: StatusTagProps<K>) {
  if (value === null || value === undefined) return <span>{placeholder ?? '—'}</span>;
  const option = map[value];
  if (!option) return <Tag bordered={bordered}>{placeholder ?? String(value)}</Tag>;
  return (
    <Tag color={option.color ?? 'default'} bordered={bordered} icon={option.icon}>
      {option.label}
    </Tag>
  );
}

/** `Select`/`Radio` options derived from the same map. */
export function statusOptions<K extends string>(map: StatusMap<K>): { label: string; value: K }[] {
  return (Object.keys(map) as K[]).map((value) => ({
    label: map[value].label,
    value,
  }));
}
