'use client';

import { Alert, Typography } from 'antd';
import Link from 'next/link';
import { groupbuyAdminStatistics } from '@shop/contracts/groupbuy/groupbuy.admin.contract';
import type { GroupbuyActivityStat } from '@shop/contracts/groupbuy/schemas';

import { PageContainer } from '@/admin/kit/page-container';
import { StatusTag } from '@/admin/kit/status-tag';
import { moneyColumn, textColumn } from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';

import { GROUPBUY_ACTIVITY_STATUS } from '../groupbuy-enums';

/**
 * 拼团统计 — one row per campaign.
 *
 * Every number is counted from the teams and their members, not from a
 * denormalised counter, so the page cannot drift from the ledgers once a
 * refund lands.
 *
 * 成团率 is 已成团 ÷ 开团数 and deliberately excludes teams still forming: a
 * campaign opened an hour ago would otherwise read 0% while nothing has gone
 * wrong. 客单价 is 支付金额 ÷ 付费人数 — members, not orders, because a group
 * buy sells one seat at a time.
 *
 * The date filter is on when a **team opened**, which is the only reading that
 * lets two periods be compared: filtering on payment time counts a team in one
 * period and its late-paying member in the next.
 */
export function GroupbuyStatisticsPage() {
  return (
    <PageContainer subTitle="按活动统计的开团、成团与支付；数字实时由团和成员算出">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="时间区间筛的是「开团时间」。成团率不计还在拼的团，客单价按付费成员算。"
      />
      <CrudTable
        route={groupbuyAdminStatistics}
        rowKey="activityId"
        scrollX={1300}
        filters={[
          { kind: 'text', name: 'activityId', label: '活动 ID' },
          { kind: 'dateRange', names: ['from', 'to'], label: '开团时间', showTime: true },
        ]}
        columns={[
          {
            title: '活动',
            key: 'title',
            width: 260,
            ellipsis: true,
            render: (_value: unknown, row: GroupbuyActivityStat) => (
              <Link href={`/admin/groupbuy/groups?activityId=${row.activityId}`}>{row.title}</Link>
            ),
          },
          {
            title: '状态',
            key: 'status',
            width: 100,
            render: (_value: unknown, row: GroupbuyActivityStat) => (
              <StatusTag value={row.status} map={GROUPBUY_ACTIVITY_STATUS} />
            ),
          },
          {
            title: '开团数',
            dataIndex: 'groups',
            key: 'groups',
            width: 100,
            align: 'right',
            sorter: true,
            showSorterTooltip: false,
          },
          {
            title: '已成团',
            dataIndex: 'succeededGroups',
            key: 'succeededGroups',
            width: 100,
            align: 'right',
          },
          {
            title: '未成团',
            dataIndex: 'failedGroups',
            key: 'failedGroups',
            width: 100,
            align: 'right',
          },
          {
            title: '还在拼',
            dataIndex: 'formingGroups',
            key: 'formingGroups',
            width: 100,
            align: 'right',
          },
          {
            title: '成团率',
            key: 'successRate',
            width: 100,
            align: 'right',
            render: (_value: unknown, row: GroupbuyActivityStat) => successRate(row),
          },
          {
            title: '付费人数',
            dataIndex: 'paidMembers',
            key: 'paidMembers',
            width: 110,
            align: 'right',
            sorter: true,
            showSorterTooltip: false,
          },
          moneyColumn<GroupbuyActivityStat>({
            title: '支付金额',
            dataIndex: 'paidAmount',
            sortable: true,
          }),
          {
            title: '退款人数',
            key: 'refundedMembers',
            width: 110,
            align: 'right',
            render: (_value: unknown, row: GroupbuyActivityStat) =>
              row.refundedMembers === 0 ? (
                <Typography.Text type="secondary">0</Typography.Text>
              ) : (
                <Typography.Text type="warning">{row.refundedMembers}</Typography.Text>
              ),
          },
          textColumn<GroupbuyActivityStat>({ title: '活动 ID', dataIndex: 'activityId' }),
        ]}
      />
    </PageContainer>
  );
}

/**
 * 已成团 ÷ (开团数 − 还在拼).
 *
 * A campaign whose every team is still forming has no rate yet, which is a
 * different thing from 0%.
 */
function successRate(row: GroupbuyActivityStat): string {
  const settled = row.groups - row.formingGroups;
  if (settled <= 0) return '—';
  return `${Math.round((row.succeededGroups / settled) * 100)}%`;
}
