'use client';

import { Button, Drawer, Typography } from 'antd';
import Link from 'next/link';
import { useState } from 'react';
import {
  groupbuyAdminActivityCreate,
  groupbuyAdminActivityDelete,
  groupbuyAdminActivityDetail,
  groupbuyAdminActivityList,
  groupbuyAdminActivityOrders,
  groupbuyAdminActivitySetStatus,
  groupbuyAdminActivityUpdate,
} from '@shop/contracts/groupbuy/groupbuy.admin.contract';
import {
  groupbuyActivityForm,
  type GroupbuyActivityDetail,
  type GroupbuyActivityListItem,
  type GroupbuyActivityOrder,
} from '@shop/contracts/groupbuy/schemas';

import { ConfirmButton } from '@/admin/kit/confirm-button';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
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
import { StatusToggleButton } from '@/admin/kit/status-toggle-button';
import { Can } from '@/admin/session/can';

import { ActivityStatusTag } from '../activity-window';

import {
  GROUPBUY_ACTIVITY_STATUS,
  GROUPBUY_GROUP_STATUS,
  GROUPBUY_MEMBER_ROLE,
  GROUPBUY_MEMBER_STATUS,
  groupbuyActivityFields,
  optionsOf,
} from '../groupbuy-enums';

/**
 * 拼团活动 — the campaign list.
 *
 * Two things here are group-buy specific and worth knowing:
 *
 *  - **还在拼 counts teams, not orders.** A campaign with teams still forming
 *    cannot be deleted: the server answers `GROUPBUY_ACTIVITY_IN_USE` rather
 *    than leaving shoppers in a team whose campaign is gone;
 *  - **editing never resets the counters.** Deleting and re-inserting the
 *    per-SKU rows on every save would zero 已售 and un-sell the campaign's
 *    stock on each edit. Here the editor first *reads* the
 *    activity — SKUs, 轮播图, 成本价 and all — and sends it back whole, so a
 *    price change is a price change and `sales` survives it.
 */
export function GroupbuyActivitiesPage() {
  // The form mounts only once the detail has arrived: seeded from the list row
  // it would have an empty 规格 list, and the save would wipe every per-SKU price.
  const modal = useFormModal<GroupbuyActivityListItem, typeof groupbuyAdminActivityDetail>({
    detail: {
      route: groupbuyAdminActivityDetail,
      params: (row) => ({ id: row.id }),
      select: formValuesOf,
    },
  });
  const editing = modal.record;
  const [ordersOf, setOrdersOf] = useState<GroupbuyActivityListItem | null>(null);

  return (
    <PageContainer subTitle="拼团活动；成团人数、有效时长和活动库存都独立于商品本身">
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
            <Button type="primary" onClick={() => modal.show()}>
              新建拼团活动
            </Button>
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
                  <Button type="link" size="small" onClick={() => modal.show(row)}>
                    编辑
                  </Button>
                  <StatusToggleButton
                    route={groupbuyAdminActivitySetStatus}
                    on={row.status === 'active'}
                    input={(next) => ({
                      params: { id: row.id },
                      body: { status: next ? ('active' as const) : ('paused' as const) },
                    })}
                    labels={['开启', '暂停']}
                    confirmTitle={`暂停拼团「${row.title}」？`}
                    confirmDescription="暂停后买家不能再开团或参团。"
                    invalidate={[groupbuyAdminActivityList]}
                    disabled={row.status === 'ended'}
                  />
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

      <ModalForm
        {...modal.props}
        title={editing ? `编辑：${editing.title}` : '新建拼团活动'}
        size="large"
        columns={2}
        schema={groupbuyActivityForm}
        fields={groupbuyActivityFields}
        route={editing ? groupbuyAdminActivityUpdate : groupbuyAdminActivityCreate}
        toInput={(values) =>
          editing ? { params: { id: editing.id }, body: values } : { body: values }
        }
        invalidate={[groupbuyAdminActivityList, groupbuyAdminActivityDetail]}
        successMessage={editing ? '已保存' : '已创建'}
      />

      <ActivityOrdersDrawer activity={ordersOf} onClose={() => setOrdersOf(null)} />
    </PageContainer>
  );
}

/**
 * The detail minus the fields the form does not own (`sales`, `views`,
 * `formingGroups`, `createdAt`, and each SKU's `sales` / `specText`), with
 * `null` turned into an absent key: `exactOptionalPropertyTypes` means an
 * optional field is either missing or a real value, never `null`.
 */
function formValuesOf(row: GroupbuyActivityDetail) {
  return {
    productId: row.productId,
    title: row.title,
    ...(row.intro === null ? {} : { intro: row.intro }),
    ...(row.imageUrl === null ? {} : { imageUrl: row.imageUrl }),
    sliderImages: row.sliderImages,
    status: row.status,
    price: row.price,
    ...(row.originalPrice === null ? {} : { originalPrice: row.originalPrice }),
    ...(row.cost === null ? {} : { cost: row.cost }),
    seatsRequired: row.seatsRequired,
    groupTtlSeconds: row.groupTtlSeconds,
    stock: row.stock,
    expectedStock: row.stock,
    ...(row.totalQuota === null ? {} : { totalQuota: row.totalQuota }),
    perOrderQuantity: row.perOrderQuantity,
    startAt: row.startAt,
    endAt: row.endAt,
    ...(row.shippingTemplateId === null ? {} : { shippingTemplateId: row.shippingTemplateId }),
    sortOrder: row.sortOrder,
    skus: row.skus.map((sku) => ({
      skuId: sku.skuId,
      price: sku.price,
      stock: sku.stock,
      expectedStock: sku.stock,
      ...(sku.quota === null ? {} : { quota: sku.quota }),
      isEnabled: sku.isEnabled,
    })),
  };
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
