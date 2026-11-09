'use client';

import { Button, Typography } from 'antd';
import Link from 'next/link';
import {
  presaleAdminActivityDelete,
  presaleAdminActivityList,
} from '@shop/contracts/presale/presale.admin.contract';
import { type PresaleActivityListItem } from '@shop/contracts/presale/schemas';

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

import { ActivityStatusTag } from '../../groupbuy/activity-window';
import { PRESALE_ACTIVITY_STATUS, PRESALE_PAYMENT_MODE } from '../presale-enums';

/** Activity history and order access. Configuration is owned by 商品编辑. */
export function PresaleActivitiesPage() {
  return (
    <PageContainer subTitle="预售配置统一在商品编辑页设置；此处保留活动历史，预售订单可在订单列表查看">
      <CrudTable
        route={presaleAdminActivityList}
        scrollX={1500}
        filters={[
          { kind: 'text', name: 'keyword', label: '标题' },
          {
            kind: 'select',
            name: 'status',
            label: '状态',
            multiple: true,
            options: Object.entries(PRESALE_ACTIVITY_STATUS).map(([value, option]) => ({
              value,
              label: option.label,
            })),
          },
          { kind: 'number', name: 'productId', label: '商品 ID', min: 1 },
        ]}
        toolbar={
          <Can permission="presale:activity:write">
            <Can permission="catalog:product:write">
              <Button type="primary" href="/admin/catalog/products">
                到商品页设置
              </Button>
            </Can>
          </Can>
        }
        columns={[
          idColumn<PresaleActivityListItem>({ sortable: true }),
          textColumn<PresaleActivityListItem>({
            title: '活动标题',
            dataIndex: 'title',
            ellipsis: true,
          }),
          textColumn<PresaleActivityListItem>({
            title: '商品',
            dataIndex: 'productName',
            ellipsis: true,
          }),
          moneyColumn<PresaleActivityListItem>({ title: '预售价', dataIndex: 'price' }),
          {
            title: '库存 / 已售',
            key: 'supply',
            width: 160,
            render: (_value: unknown, row: PresaleActivityListItem) => (
              <Typography.Text>
                剩 {row.stock}
                <Typography.Text type="secondary"> / 已售 {row.sales}</Typography.Text>
                {row.totalQuota === null ? null : (
                  <Typography.Text type="secondary"> / 限 {row.totalQuota}</Typography.Text>
                )}
              </Typography.Text>
            ),
          },
          {
            title: '发货承诺',
            key: 'shipAfterDays',
            width: 130,
            render: (_value: unknown, row: PresaleActivityListItem) =>
              row.shipAfterDays === 0 ? '付款后即发' : `付款后 ${row.shipAfterDays} 天内`,
          },
          instantColumn<PresaleActivityListItem>({
            title: '开始时间',
            dataIndex: 'startAt',
            sortable: true,
          }),
          instantColumn<PresaleActivityListItem>({ title: '结束时间', dataIndex: 'endAt' }),
          enumColumn<PresaleActivityListItem, PresaleActivityListItem['paymentMode']>({
            title: '付款方式',
            dataIndex: 'paymentMode',
            map: PRESALE_PAYMENT_MODE,
          }),
          {
            title: '状态',
            key: 'status',
            width: 100,
            render: (_value: unknown, row: PresaleActivityListItem) => (
              <ActivityStatusTag row={row} map={PRESALE_ACTIVITY_STATUS} />
            ),
          },
          actionsColumn<PresaleActivityListItem>({
            width: 180,
            render: (row) => (
              <>
                <Can permission="presale:activity:write">
                  <Can permission="catalog:product:write">
                    <Link href={`/admin/catalog/products/${row.productId}`}>编辑</Link>
                  </Can>
                </Can>
                <ConfirmButton
                  route={presaleAdminActivityDelete}
                  input={{ params: { id: row.id } }}
                  title="确认删除该预售活动？"
                  description="还有未完成预售订单时无法删除；已完成的订单不受影响。"
                  invalidate={[presaleAdminActivityList]}
                  successMessage="已删除"
                  permission="presale:activity:delete"
                  buttonProps={{ type: 'link', size: 'small', danger: true }}
                >
                  删除
                </ConfirmButton>
              </>
            ),
          }),
        ]}
      />
    </PageContainer>
  );
}
