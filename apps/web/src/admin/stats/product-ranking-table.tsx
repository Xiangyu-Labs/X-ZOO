'use client';

import { Avatar, Card, Select, Space, Table, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { statsProductRanking } from '@shop/contracts/stats/stats.admin.contract';
import type { ProductRankingRow, ProductRankingSort } from '@shop/contracts/stats/schemas';

import { useRouteQuery } from '@/admin/api/hooks';

import { formatFigure } from './format';

const SORTS: { value: ProductRankingSort; label: string; money?: boolean }[] = [
  { value: 'paidAmount', label: '支付金额', money: true },
  { value: 'paidQuantity', label: '支付件数' },
  { value: 'orderQuantity', label: '下单件数' },
  { value: 'cartQuantity', label: '加购件数' },
  { value: 'views', label: '浏览量' },
  { value: 'visitors', label: '访客数' },
  { value: 'favorites', label: '收藏数' },
];

/**
 * 商品排行. Shared by 商品统计 and the work surface.
 *
 * Sorting happens in SQL over the whole window, not in the table: the top 20
 * by 支付金额 is a different set of products from the top 20 by 浏览量, so
 * re-sorting rows already fetched would quietly answer a different question.
 */
export function ProductRankingTable({
  query,
  defaultSort = 'paidAmount',
  defaultLimit = 20,
  title = '商品排行',
  controls = true,
  extra,
}: {
  query: { from?: string; to?: string };
  defaultSort?: ProductRankingSort;
  defaultLimit?: number;
  title?: string;
  controls?: boolean;
  extra?: React.ReactNode;
}) {
  const [sortBy, setSortBy] = useState<ProductRankingSort>(defaultSort);
  const [limit, setLimit] = useState(defaultLimit);

  const { data, isPending } = useRouteQuery(statsProductRanking, {
    query: { ...query, sortBy, limit },
  });

  return (
    <Card
      size="small"
      title={title}
      extra={
        <Space>
          {controls ? (
            <>
              <Select<ProductRankingSort>
                value={sortBy}
                onChange={setSortBy}
                options={SORTS}
                style={{ width: 130 }}
              />
              <Select
                value={limit}
                onChange={setLimit}
                options={[10, 20, 50, 100].map((value) => ({ value, label: `前 ${value} 名` }))}
                style={{ width: 120 }}
              />
            </>
          ) : null}
          {extra}
        </Space>
      }
    >
      <Table<ProductRankingRow>
        size="small"
        rowKey="productId"
        pagination={false}
        scroll={{ x: 1080 }}
        loading={isPending}
        dataSource={data?.rows ?? []}
        locale={{ emptyText: '暂无数据' }}
        columns={[
          {
            title: '#',
            key: 'rank',
            width: 56,
            render: (_: unknown, __: ProductRankingRow, index: number) => index + 1,
          },
          {
            title: '商品',
            dataIndex: 'name',
            key: 'name',
            width: 280,
            render: (name: string, row: ProductRankingRow) => (
              <Space>
                <Avatar shape="square" size="small" src={row.imageUrl ?? undefined} />
                <Typography.Text ellipsis style={{ maxWidth: 200 }}>
                  {name}
                </Typography.Text>
              </Space>
            ),
          },
          ...SORTS.map((sort) => ({
            title: sort.label,
            dataIndex: sort.value,
            key: sort.value,
            align: 'right' as const,
            width: 110,
            render: (value: number) => formatFigure(value, sort.money ? 'money' : 'count'),
          })),
          {
            title: (
              <Tooltip title="支付过该商品的访客 ÷ 访客数">
                <span>访问-支付转化率</span>
              </Tooltip>
            ),
            dataIndex: 'conversion',
            key: 'conversion',
            align: 'right' as const,
            width: 140,
            render: (value: number) => formatFigure(value, 'percent'),
          },
        ]}
      />
    </Card>
  );
}
