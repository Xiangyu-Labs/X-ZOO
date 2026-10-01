'use client';

import { Card, Select, Space, Table, Tooltip } from 'antd';
import { useState } from 'react';
import { statsUserRegions, statsUsers } from '@shop/contracts/stats/stats.admin.contract';
import type { UserRegionQuery, UserRegionStats } from '@shop/contracts/stats/schemas';

import { useRouteQuery } from '@/admin/api/hooks';
import { formatFigure, StatsPageFrame, useStatsRange } from '@/admin/stats';

type RegionSort = UserRegionQuery['sortBy'];
// The contract exports the row *schema* but not its type; deriving it here
// keeps the contract untouched.
type UserRegionRow = UserRegionStats['rows'][number];

const SORTS: { value: RegionSort; label: string }[] = [
  { value: 'totalUsers', label: '累计用户' },
  { value: 'newUsers', label: '新增用户' },
  { value: 'visitors', label: '访客数' },
  { value: 'paidAmount', label: '支付金额' },
];

/**
 * 用户统计 — registrations, buyers, traffic, and the province table.
 *
 * The columns of 地域分布 come from three different places: 累计用户 /
 * 新增用户 from the user's default address, 访客数 from the province recorded
 * on the visit (the visitor's default address at the time; anonymous visits
 * have none), 支付金额 from the order's receiver province. Each column uses the
 * province that column actually knows, because one join cannot serve all three
 * without silently dropping every buyer who never saved an address.
 */
export function UserStatsPage() {
  const range = useStatsRange();
  const [sortBy, setSortBy] = useState<RegionSort>('totalUsers');
  const [limit, setLimit] = useState(10);

  const { data, isPending } = useRouteQuery(statsUsers, { query: range.query });
  const regions = useRouteQuery(statsUserRegions, {
    query: { ...range.query, sortBy, limit },
  });

  return (
    <StatsPageFrame
      subTitle="新增用户按注册时间，成交用户按支付时间，累计用户是区间结束时的总数；停留时长只计已上报的访问"
      range={range}
      data={data}
      loading={isPending}
      metricColumns={6}
      chartTitle="用户趋势"
    >
      <Card
        size="small"
        title="地域分布"
        extra={
          <Space>
            <Select<RegionSort>
              value={sortBy}
              onChange={setSortBy}
              options={SORTS}
              style={{ width: 140 }}
            />
            <Select
              value={limit}
              onChange={setLimit}
              options={[10, 20, 50].map((value) => ({ value, label: `前 ${value} 名` }))}
              style={{ width: 120 }}
            />
          </Space>
        }
      >
        <Table<UserRegionRow>
          size="small"
          rowKey="province"
          pagination={false}
          loading={regions.isPending}
          dataSource={regions.data?.rows ?? []}
          locale={{ emptyText: '暂无数据' }}
          columns={[
            {
              title: '省份',
              dataIndex: 'province',
              key: 'province',
              render: (province: string) =>
                province === '未知' ? (
                  <Tooltip title="用户没有默认收货地址；未登录的访问也计入这里">未知</Tooltip>
                ) : (
                  province
                ),
            },
            ...SORTS.map((sort) => ({
              title: sort.label,
              dataIndex: sort.value,
              key: sort.value,
              align: 'right' as const,
              render: (value: number) =>
                formatFigure(value, sort.value === 'paidAmount' ? 'money' : 'count'),
            })),
          ]}
        />
      </Card>
    </StatsPageFrame>
  );
}
