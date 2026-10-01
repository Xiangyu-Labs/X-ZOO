'use client';

import { Card, Descriptions, Skeleton } from 'antd';
import type { ReactNode } from 'react';

export interface DescriptionEntry {
  label: ReactNode;
  value: ReactNode;
  /** Columns this row spans. */
  span?: number | undefined;
  /** Drop the row entirely (e.g. a field that only applies to some records). */
  hidden?: boolean | undefined;
}

export interface DescriptionsCardProps {
  title?: ReactNode | undefined;
  extra?: ReactNode | undefined;
  items: DescriptionEntry[];
  /**
   * Columns at desktop width; the kit narrows this on small screens and never
   * widens it — `column={1}` is one column at every width.
   */
  column?: number | undefined;
  loading?: boolean | undefined;
  bordered?: boolean | undefined;
  size?: 'default' | 'middle' | 'small' | undefined;
}

/**
 * Read-only detail panel. The standard way to show "what this record is"
 * above tabs or a form.
 *
 * ```tsx
 * <DescriptionsCard
 *   title="订单信息"
 *   items={[
 *     { label: '订单号', value: order.no },
 *     { label: '金额', value: <MoneyText value={order.total} /> },
 *     { label: '下单时间', value: <InstantText value={order.createdAt} /> },
 *   ]}
 * />
 * ```
 */
export function DescriptionsCard({
  title,
  extra,
  items,
  column = 3,
  loading = false,
  bordered = true,
  size = 'small',
}: DescriptionsCardProps) {
  const visible = items.filter((item) => !item.hidden);

  return (
    <Card title={title} extra={extra} size="small">
      {loading ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : (
        <Descriptions
          bordered={bordered}
          size={size}
          column={{ xs: 1, sm: 1, md: Math.min(2, column), lg: column, xl: column, xxl: column }}
          items={visible.map((item, index) => ({
            key: `${index}`,
            label: item.label,
            children: item.value ?? '—',
            ...(item.span ? { span: item.span } : {}),
          }))}
        />
      )}
    </Card>
  );
}
