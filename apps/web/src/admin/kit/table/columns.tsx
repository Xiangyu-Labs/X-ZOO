'use client';

import { Space, Tooltip, Typography } from 'antd';
import type { ColumnType } from 'antd/es/table';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { ErrorSummary } from '../error-summary';
import type { InstantFormat } from '../instant';
import { InstantText } from '../instant-text';
import { MoneyText } from '../money-text';
import { StatusTag, type StatusMap } from '../status-tag';
import { Thumbnail } from '../thumbnail';

interface CommonColumnOptions<T> {
  title: ReactNode;
  dataIndex: keyof T & string;
  width?: number | undefined;
  /** Server-side sorting. The table puts `sortBy`/`sortOrder` in the query. */
  sortable?: boolean | undefined;
  align?: 'left' | 'center' | 'right' | undefined;
  fixed?: 'left' | 'right' | undefined;
}

function base<T>(options: CommonColumnOptions<T>): ColumnType<T> {
  return {
    title: options.title,
    dataIndex: options.dataIndex,
    key: options.dataIndex,
    ...(options.width !== undefined ? { width: options.width } : {}),
    ...(options.align ? { align: options.align } : {}),
    ...(options.fixed ? { fixed: options.fixed } : {}),
    ...(options.sortable ? { sorter: true, showSorterTooltip: false } : {}),
  };
}

/** Plain text with optional truncation and a hover tooltip. */
export function textColumn<T>(
  options: CommonColumnOptions<T> & { ellipsis?: boolean; placeholder?: string },
): ColumnType<T> {
  return {
    ...base(options),
    ...(options.ellipsis ? { ellipsis: { showTitle: false } } : {}),
    render: (value: unknown) => {
      const text =
        value === null || value === undefined || value === ''
          ? (options.placeholder ?? '—')
          : String(value);
      return options.ellipsis ? (
        <Tooltip title={text}>
          <span>{text}</span>
        </Tooltip>
      ) : (
        <span>{text}</span>
      );
    },
  };
}

/**
 * The width a column needs to show a `chars`-long number whole: tabular digits
 * at 14px, the copy icon, and the cell's padding.
 *
 * Tables with a fixed column lay out as `table-layout: fixed`, where a column
 * without a width is squeezed and an unwrappable number spills into the next
 * cell, so a column of numbers always says how wide it is.
 */
export function codeWidth(chars: number): number {
  return Math.ceil(chars * 8.6) + 48;
}

/** 订单号 and 售后单号: an optional prefix, then 24 digits (`generateOrderNo`). */
const ORDER_NO_CHARS = 26;

/**
 * A number people copy or search by: 订单号, 售后单号, 微信单号, 商户单号.
 * Never truncated (half an order number is useless), never wrapped, one click
 * to copy, and optionally a link to the record it names.
 *
 * `chars` is the longest the number gets (default an order number; 微信单号 is
 * 28); an explicit `width` wins.
 */
export function codeColumn<T>(
  options: CommonColumnOptions<T> & {
    /** Where the number leads, e.g. the order's detail page. */
    href?: ((row: T) => string | null | undefined) | undefined;
    copyable?: boolean | undefined;
    placeholder?: string | undefined;
    chars?: number | undefined;
  },
): ColumnType<T> {
  return {
    ...base({ ...options, width: options.width ?? codeWidth(options.chars ?? ORDER_NO_CHARS) }),
    render: (value: unknown, row: T) => (
      <CodeText
        value={value === null || value === undefined ? undefined : String(value)}
        href={options.href?.(row) ?? undefined}
        copyable={options.copyable ?? true}
        placeholder={options.placeholder}
      />
    ),
  };
}

/**
 * A record's last failure: the Chinese `summary` on one line, and the raw
 * `detail` behind 技术详情 (`<ErrorSummary>`). A raw error field never gets a
 * `textColumn` of its own: staff read Chinese only.
 */
export function errorColumn<T>(
  options: Omit<CommonColumnOptions<T>, 'dataIndex' | 'sortable'> & {
    /** The Chinese field, e.g. `lastErrorSummary`. */
    summary: keyof T & string;
    /** The raw field, e.g. `lastError`. */
    detail: keyof T & string;
  },
): ColumnType<T> {
  return {
    ...base({ ...options, dataIndex: options.summary }),
    ellipsis: { showTitle: false },
    render: (_value: unknown, row: T) => (
      <ErrorSummary
        summary={textOrNull(row[options.summary])}
        detail={textOrNull(row[options.detail])}
        ellipsis
      />
    ),
  };
}

/** The cell of `codeColumn`, for the same number outside a table. */
export function CodeText({
  value,
  href,
  copyable = true,
  placeholder = '—',
}: {
  value: string | undefined;
  href?: string | undefined;
  copyable?: boolean | undefined;
  placeholder?: string | undefined;
}) {
  if (!value) return <Typography.Text type="secondary">{placeholder}</Typography.Text>;
  return (
    <Typography.Text
      copyable={copyable ? { text: value } : false}
      style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}
    >
      {href ? <Link href={href}>{value}</Link> : value}
    </Typography.Text>
  );
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

/** Money string, right-aligned, tabular figures. Never a float. */
export function moneyColumn<T>(
  options: CommonColumnOptions<T> & { symbol?: string; colored?: boolean },
): ColumnType<T> {
  return {
    ...base({ align: 'right', ...options }),
    render: (value: unknown) => (
      <MoneyText
        value={typeof value === 'string' ? value : undefined}
        symbol={options.symbol ?? '¥'}
        colored={options.colored ?? false}
      />
    ),
  };
}

/** ISO instant rendered in Asia/Shanghai. */
export function instantColumn<T>(
  options: CommonColumnOptions<T> & { format?: InstantFormat },
): ColumnType<T> {
  return {
    ...base({ width: 170, ...options }),
    render: (value: unknown) => (
      <InstantText
        value={typeof value === 'string' ? value : undefined}
        format={options.format ?? 'minute'}
      />
    ),
  };
}

/** Square thumbnail that opens full size on click. `dataIndex` may hold a URL or an `asset`. */
export function imageColumn<T>(
  options: Omit<CommonColumnOptions<T>, 'sortable'> & { size?: number },
): ColumnType<T> {
  const size = options.size ?? 44;
  return {
    ...base({ ...options, width: options.width ?? size + 24 }),
    render: (value: unknown) => {
      const url =
        typeof value === 'string'
          ? value
          : value && typeof value === 'object' && 'url' in value
            ? String((value as { url: unknown }).url)
            : '';
      if (!url) return <span style={{ color: 'var(--ant-color-text-quaternary)' }}>—</span>;
      return <Thumbnail src={url} size={size} />;
    },
  };
}

/** Enum rendered through a shared `StatusMap`, so colours never drift. */
export function enumColumn<T, K extends string = string>(
  options: CommonColumnOptions<T> & { map: StatusMap<K> },
): ColumnType<T> {
  return {
    ...base({ width: 110, ...options }),
    render: (value: unknown) => <StatusTag value={value as K | undefined} map={options.map} />,
  };
}

/** Trailing action column. Wrap individual actions in `<Can>`. */
export function actionsColumn<T>(options: {
  title?: ReactNode | undefined;
  width?: number | undefined;
  fixed?: 'right' | false | undefined;
  render: (row: T, index: number) => ReactNode;
}): ColumnType<T> {
  return {
    title: options.title ?? '操作',
    key: '__actions__',
    width: options.width ?? 160,
    ...(options.fixed === false ? {} : { fixed: 'right' as const }),
    render: (_value: unknown, row: T, index: number) => (
      <Space size={4} wrap>
        {options.render(row, index)}
      </Space>
    ),
  };
}

/** Monospaced id column; handy because ids are decimal strings, not numbers. */
export function idColumn<T>(
  options: Partial<CommonColumnOptions<T>> & { dataIndex?: keyof T & string } = {},
): ColumnType<T> {
  return {
    title: options.title ?? 'ID',
    dataIndex: (options.dataIndex ?? 'id') as string,
    key: options.dataIndex ?? 'id',
    width: options.width ?? 90,
    ...(options.sortable ? { sorter: true, showSorterTooltip: false } : {}),
    render: (value: unknown) => (
      <Typography.Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {String(value ?? '—')}
      </Typography.Text>
    ),
  };
}
