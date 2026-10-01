'use client';

import { Alert, Avatar, Button, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import {
  groupbuyAdminGroupComplete,
  groupbuyAdminGroupDetail,
  groupbuyAdminGroupList,
} from '@shop/contracts/groupbuy/groupbuy.admin.contract';
import {
  groupbuyCompleteBody,
  type GroupbuyGroupListItem,
  type GroupbuyMember,
} from '@shop/contracts/groupbuy/schemas';

import { useRouteQuery } from '@/admin/api/hooks';
import { DescriptionsCard } from '@/admin/kit/descriptions-card';
import { DetailDrawer } from '@/admin/kit/detail-drawer';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { InstantText } from '@/admin/kit/instant-text';
import { PageContainer } from '@/admin/kit/page-container';
import { StatusTag } from '@/admin/kit/status-tag';
import {
  actionsColumn,
  CodeText,
  codeWidth,
  idColumn,
  instantColumn,
  textColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { Can } from '@/admin/session/can';
import { useCan } from '@/admin/session/session-provider';

import {
  GROUPBUY_GROUP_STATUS,
  GROUPBUY_MEMBER_ROLE,
  GROUPBUY_MEMBER_STATUS,
  optionsOf,
} from '../groupbuy-enums';

/**
 * 拼团列表 — one row per team.
 *
 * A team is a row with a seat counter, not a list of participants to count, so
 * 人数 is `seatsTaken / seatsTotal` straight from the row and always agrees
 * with what the shopper's status page shows.
 *
 * **A seat means a paid order.** An unpaid order holds nothing: it reserved
 * stock, it did not join the team. That is why a team can read 1/3 while three
 * orders exist.
 *
 * 立即成团 is offered only on a team whose seats are all taken. 虚拟成团 is off
 * for good, so the server refuses an under-filled team
 * (`GROUPBUY_VIRTUAL_FILL_DISABLED`); a button that can only fail is not shown.
 */
export function GroupbuyGroupsPage() {
  const [detailId, setDetailId] = useState<string | null>(null);
  const completeModal = useFormModal<GroupbuyGroupListItem>();

  return (
    <PageContainer subTitle="每一行是一个团；座位以「已支付」计，未支付的订单不占座">
      <CrudTable
        route={groupbuyAdminGroupList}
        scrollX={1400}
        filters={[
          { kind: 'text', name: 'activityId', label: '活动 ID' },
          { kind: 'text', name: 'leaderUserId', label: '团长用户 ID' },
          {
            kind: 'select',
            name: 'status',
            label: '状态',
            multiple: true,
            options: optionsOf(GROUPBUY_GROUP_STATUS),
          },
        ]}
        columns={[
          idColumn<GroupbuyGroupListItem>({ sortable: true }),
          textColumn<GroupbuyGroupListItem>({
            title: '活动',
            dataIndex: 'activityTitle',
            ellipsis: true,
          }),
          {
            title: '团长',
            key: 'leader',
            width: 160,
            render: (_value: unknown, row: GroupbuyGroupListItem) => (
              <Typography.Text>
                {row.leaderNickname ?? '—'}
                <Typography.Text type="secondary"> #{row.leaderUserId}</Typography.Text>
              </Typography.Text>
            ),
          },
          {
            title: '人数',
            key: 'seats',
            width: 110,
            render: (_value: unknown, row: GroupbuyGroupListItem) => (
              <Typography.Text>
                {row.seatsTaken} / {row.seatsTotal}
                {row.virtuallyFilled ? (
                  <Tag color="purple" style={{ marginLeft: 6 }}>
                    虚拟
                  </Tag>
                ) : null}
              </Typography.Text>
            ),
          },
          {
            title: '状态',
            key: 'status',
            width: 110,
            render: (_value: unknown, row: GroupbuyGroupListItem) => (
              <StatusTag value={row.status} map={GROUPBUY_GROUP_STATUS} />
            ),
          },
          instantColumn<GroupbuyGroupListItem>({
            title: '截止时间',
            dataIndex: 'expiresAt',
            sortable: true,
          }),
          instantColumn<GroupbuyGroupListItem>({ title: '成团时间', dataIndex: 'succeededAt' }),
          instantColumn<GroupbuyGroupListItem>({
            title: '开团时间',
            dataIndex: 'createdAt',
            sortable: true,
          }),
          actionsColumn<GroupbuyGroupListItem>({
            width: 170,
            render: (row) => (
              <>
                <Button type="link" size="small" onClick={() => setDetailId(row.id)}>
                  详情
                </Button>
                {row.status === 'forming' && row.seatsTaken >= row.seatsTotal ? (
                  <Can permission="groupbuy:group:complete">
                    <Button type="link" size="small" onClick={() => completeModal.show(row)}>
                      立即成团
                    </Button>
                  </Can>
                ) : null}
              </>
            ),
          }),
        ]}
      />

      <GroupDrawer
        id={detailId}
        onClose={() => setDetailId(null)}
        onComplete={(group) => completeModal.show(group)}
      />

      <ModalForm
        {...completeModal.props}
        title={completeModal.record ? `立即成团：#${completeModal.record.id}` : '立即成团'}
        size="small"
        schema={groupbuyCompleteBody}
        fields={[
          {
            kind: 'textarea',
            name: 'reason',
            label: '原因',
            rows: 3,
            maxLength: 255,
            help: '写给日后查账的人看。操作人由系统记录，不必写在这里。',
          },
        ]}
        route={groupbuyAdminGroupComplete}
        toInput={(values) => ({
          params: { id: completeModal.record?.id ?? '' },
          body: values,
        })}
        invalidate={[groupbuyAdminGroupList, groupbuyAdminGroupDetail]}
        successMessage="已成团"
        okText="确认成团"
        header={
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="本店不支持虚拟成团：只有人数已满的团可以立即成团。"
            description="未满员的团会被拒绝，到截止时间自动失败并给已付款的成员原路退款。"
          />
        }
      />
    </PageContainer>
  );
}

/**
 * 团详情.
 *
 * The member table is the whole point: it shows everyone who ever joined,
 * including the ones who left. A refunded member keeps their row with 已退款 —
 * deleting the participation row on refund would make a failed team's history
 * unrecoverable and let 团长 appear to be somebody else.
 */
function GroupDrawer({
  id,
  onClose,
  onComplete,
}: {
  id: string | null;
  onClose: () => void;
  onComplete: (group: GroupbuyGroupListItem) => void;
}) {
  const detail = useRouteQuery(
    groupbuyAdminGroupDetail,
    id === null ? undefined : { params: { id } },
    { enabled: id !== null, presentError: false },
  );
  const mayComplete = useCan()('groupbuy:group:complete');

  return (
    <DetailDrawer
      open={id !== null}
      onClose={onClose}
      size="large"
      title={`拼团 #${id ?? ''}`}
      query={detail}
      footer={
        mayComplete
          ? (group) =>
              group.status === 'forming' && group.seatsTaken >= group.seatsTotal ? (
                <Button type="primary" onClick={() => onComplete(group)}>
                  立即成团
                </Button>
              ) : null
          : undefined
      }
    >
      {(group) => (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <DescriptionsCard
            title="基本信息"
            column={2}
            items={[
              { label: '活动', value: `${group.activityTitle}（#${group.activityId}）` },
              {
                label: '状态',
                value: <StatusTag value={group.status} map={GROUPBUY_GROUP_STATUS} />,
              },
              {
                label: '团长',
                value: `${group.leaderNickname ?? '—'}（#${group.leaderUserId}）`,
              },
              {
                label: '人数',
                value: `${group.seatsTaken} / ${group.seatsTotal}${
                  group.virtuallyFilled ? '（虚拟成团）' : ''
                }`,
              },
              { label: '开团时间', value: <InstantText value={group.createdAt} /> },
              { label: '截止时间', value: <InstantText value={group.expiresAt} /> },
              {
                label: '成团时间',
                value: <InstantText value={group.succeededAt ?? undefined} />,
              },
              {
                label: '失败时间',
                value: <InstantText value={group.failedAt ?? undefined} />,
              },
            ]}
          />

          <Table<GroupbuyMember>
            rowKey="id"
            size="small"
            title={() => '成员'}
            dataSource={group.members}
            pagination={false}
            columns={[
              {
                title: '用户',
                key: 'user',
                render: (_value: unknown, row: GroupbuyMember) => (
                  <Space>
                    <Avatar size="small" src={row.avatarUrl ?? undefined}>
                      {(row.nickname ?? '?').slice(0, 1)}
                    </Avatar>
                    <Typography.Text>{row.nickname ?? `用户 #${row.userId}`}</Typography.Text>
                  </Space>
                ),
              },
              {
                title: '身份',
                key: 'role',
                width: 80,
                render: (_value: unknown, row: GroupbuyMember) => (
                  <StatusTag value={row.role} map={GROUPBUY_MEMBER_ROLE} />
                ),
              },
              {
                title: '成员状态',
                key: 'status',
                width: 100,
                render: (_value: unknown, row: GroupbuyMember) => (
                  <StatusTag value={row.status} map={GROUPBUY_MEMBER_STATUS} />
                ),
              },
              {
                title: '订单号',
                key: 'orderNo',
                width: codeWidth(26),
                render: (_value: unknown, row: GroupbuyMember) => (
                  <CodeText value={row.orderNo} href={`/admin/orders/${row.orderId}`} />
                ),
              },
              { title: '份数', dataIndex: 'quantity', key: 'quantity', width: 70 },
              {
                title: '支付',
                key: 'paid',
                width: 80,
                render: (_value: unknown, row: GroupbuyMember) =>
                  row.paid ? '已支付' : <Typography.Text type="secondary">未支付</Typography.Text>,
              },
              {
                title: '参团时间',
                key: 'joinedAt',
                width: 170,
                render: (_value: unknown, row: GroupbuyMember) => (
                  <InstantText value={row.joinedAt} />
                ),
              },
              {
                title: '离开时间',
                key: 'leftAt',
                width: 170,
                render: (_value: unknown, row: GroupbuyMember) => (
                  <InstantText value={row.leftAt ?? undefined} />
                ),
              },
            ]}
          />
        </Space>
      )}
    </DetailDrawer>
  );
}
