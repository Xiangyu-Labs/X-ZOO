'use client';

import { Button, Drawer, Typography } from 'antd';
import Link from 'next/link';
import { useState } from 'react';
import {
  groupbuyAdminActivityDelete,
  groupbuyAdminActivityList,
  groupbuyAdminActivityOrders,
} from '@shop/contracts/groupbuy/groupbuy.admin.contract';
import {
  type GroupbuyActivityListItem,
  type GroupbuyActivityOrder,
} from '@shop/contracts/groupbuy/schemas';

import { ConfirmButton } from '@/admin/kit/confirm-button';
import { PageContainer } from '@/admin/kit/page-container';
import {
  actionsColumn,
  enumColumn,
  idColumn,
  instantColumn,
  moneyColumn,
  textColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { Can } from '@/admin/session/can';

import { ActivityStatusTag } from '../activity-window';

import {
  GROUPBUY_ACTIVITY_STATUS,
  GROUPBUY_GROUP_STATUS,
  GROUPBUY_MEMBER_ROLE,
  GROUPBUY_MEMBER_STATUS,
  optionsOf,
} from '../groupbuy-enums';

/** Activity history and order access. Configuration is owned by 商品编辑. */
export function GroupbuyActivitiesPage() {
  const [ordersOf, setOrdersOf] = useState<GroupbuyActivityListItem | null>(null);

  return (
    <PageContainer subTitle="拼单配置统一在商品编辑页设置；此处保留活动历史和订单查看">
      <CrudTable
        route={groupbuyAdminActivityList}
        scrollX={1560}
        filters={[
          { kind: 'text', name: 'keyword', label: '活动标题' },
          { kind: 'text', name: 'productId', label: '商品 ID' },
          {
            kind: 'select',
            name: 'status',
            label: '状态',
            multiple: true,
            options: optionsOf(GROUPBUY_ACTIVITY_STATUS),
          },
        ]}
        toolbar={
          <Can permission="groupbuy:activity:write">
            <Can permission="catalog:product:write">
              <Button type="primary" href="/admin/catalog/products">
                到商品页设置
              </Button>
            </Can>
          </Can>
        }
        columns={[
          idColumn<GroupbuyActivityListItem>({ sortable: true }),
          textColumn<GroupbuyActivityListItem>({
            title: '活动标题',
            dataIndex: 'title',
            ellipsis: true,
          }),
          textColumn<GroupbuyActivityListItem>({
            title: '商品',
            dataIndex: 'productName',
            ellipsis: true,
          }),
          moneyColumn<GroupbuyActivityListItem>({ title: '拼团价', dataIndex: 'price' }),
          {
            title: '成团人数',
            key: 'seatsRequired',
            width: 100,
            render: (_value: unknown, row: GroupbuyActivityListItem) => `${row.seatsRequired} 人`,
          },
          {
            title: '库存 / 已售',
            key: 'stock',
            width: 150,
            render: (_value: unknown, row: GroupbuyActivityListItem) => (
              <Typography.Text>
                {row.stock}
                <Typography.Text type="secondary"> / 已售 {row.sales}</Typography.Text>
                {row.totalQuota === null ? null : (
                  <Typography.Text type="secondary"> / 限 {row.totalQuota}</Typography.Text>
                )}
              </Typography.Text>
            ),
          },
          {
            title: '还在拼',
            key: 'formingGroups',
            width: 100,
            render: (_value: unknown, row: GroupbuyActivityListItem) =>
              row.formingGroups === 0 ? (
                <Typography.Text type="secondary">—</Typography.Text>
              ) : (
                <Link href={`/admin/groupbuy/groups?activityId=${row.id}&status=forming`}>
                  {row.formingGroups} 个团
                </Link>
              ),
          },
          {
            title: '状态',
            key: 'status',
            width: 100,
            render: (_value: unknown, row: GroupbuyActivityListItem) => (
              <ActivityStatusTag row={row} map={GROUPBUY_ACTIVITY_STATUS} />
            ),
          },
          instantColumn<GroupbuyActivityListItem>({
            title: '开始',
            dataIndex: 'startAt',
            sortable: true,
          }),
          instantColumn<GroupbuyActivityListItem>({ title: '结束', dataIndex: 'endAt' }),
          actionsColumn<GroupbuyActivityListItem>({
            width: 240,
            render: (row) => (
              <>
                <Can permission="groupbuy:activity:write">
                  <Can permission="catalog:product:write">
                    <Link href={`/admin/catalog/products/${row.productId}`}>编辑</Link>
                  </Can>
                </Can>
                <Can permission="groupbuy:group:read">
                  <Button type="link" size="small" onClick={() => setOrdersOf(row)}>
                    订单
                  </Button>
                </Can>
                <ConfirmButton
                  route={groupbuyAdminActivityDelete}
                  input={{ params: { id: row.id } }}
                  title="确认删除该拼团活动？"
                  description="还有团在拼时无法删除；已成团的订单不受影响。"
                  invalidate={[groupbuyAdminActivityList]}
                  successMessage="已删除"
                  permission="groupbuy:activity:delete"
                  buttonProps={{ type: 'link', size: 'small', danger: true }}
                >
                  删除
                </ConfirmButton>
              </>
            ),
          }),
        ]}
      />

      <ActivityOrdersDrawer activity={ordersOf} onClose={() => setOrdersOf(null)} />
    </PageContainer>
  );
}

/**
 * 拼团订单 for one campaign.
 *
 * The row that matters is a *member*, not an order line: it carries the team it
 * belongs to, the member's own status and the team's, because "paid but the
 * team failed" and "paid and shipped" look identical on an order list and mean
 * opposite things to the person asking.
 */
function ActivityOrdersDrawer({
  activity,
  onClose,
}: {
  activity: GroupbuyActivityListItem | null;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={activity !== null}
      onClose={onClose}
      width={1040}
      title={activity ? `拼团订单：${activity.title}` : '拼团订单'}
      destroyOnHidden
    >
      {activity ? (
        <CrudTable
          route={groupbuyAdminActivityOrders}
          params={{ id: activity.id }}
          urlPrefix="orders"
          scrollX={1100}
          filters={[
            {
              kind: 'select',
              name: 'groupStatus',
              label: '拼团状态',
              options: optionsOf(GROUPBUY_GROUP_STATUS),
            },
            {
              kind: 'select',
              name: 'paid',
              label: '支付',
              options: [
                { label: '已支付', value: 'true' },
                { label: '未支付', value: 'false' },
              ],
            },
          ]}
          rowKey="orderId"
          columns={[
            textColumn<GroupbuyActivityOrder>({
              title: '订单号',
              dataIndex: 'orderNo',
              width: 200,
            }),
            idColumn<GroupbuyActivityOrder>({ title: '所属团', dataIndex: 'groupId' }),
            {
              title: '用户',
              key: 'nickname',
              // No nickname: never set, or blanked on 注销. The team drawer says the same.
              render: (_value: unknown, row: GroupbuyActivityOrder) =>
                row.nickname ?? `用户 #${row.userId}`,
            },
            enumColumn<GroupbuyActivityOrder, GroupbuyActivityOrder['role']>({
              title: '身份',
              dataIndex: 'role',
              map: GROUPBUY_MEMBER_ROLE,
              width: 90,
            }),
            {
              title: '份数',
              key: 'quantity',
              width: 80,
              render: (_value: unknown, row: GroupbuyActivityOrder) => row.quantity,
            },
            moneyColumn<GroupbuyActivityOrder>({ title: '应付', dataIndex: 'payableAmount' }),
            {
              title: '支付',
              key: 'paid',
              width: 90,
              render: (_value: unknown, row: GroupbuyActivityOrder) =>
                row.paid ? '已支付' : <Typography.Text type="secondary">未支付</Typography.Text>,
            },
            enumColumn<GroupbuyActivityOrder, GroupbuyActivityOrder['memberStatus']>({
              title: '成员状态',
              dataIndex: 'memberStatus',
              map: GROUPBUY_MEMBER_STATUS,
            }),
            enumColumn<GroupbuyActivityOrder, GroupbuyActivityOrder['groupStatus']>({
              title: '拼团状态',
              dataIndex: 'groupStatus',
              map: GROUPBUY_GROUP_STATUS,
            }),
            instantColumn<GroupbuyActivityOrder>({ title: '下单时间', dataIndex: 'createdAt' }),
            actionsColumn<GroupbuyActivityOrder>({
              width: 90,
              fixed: false,
              render: (row) => <Link href={`/admin/orders/${row.orderId}`}>订单详情</Link>,
            }),
          ]}
        />
      ) : null}
    </Drawer>
  );
}
