'use client';

import { Typography } from 'antd';
import { presaleAdminOrderList } from '@shop/contracts/presale/presale.admin.contract';
import type { PresaleOrderItem } from '@shop/contracts/presale/schemas';

import { PageContainer } from '@/admin/kit/page-container';
import { StatusTag } from '@/admin/kit/status-tag';
import {
  codeColumn,
  enumColumn,
  idColumn,
  instantColumn,
  moneyColumn,
  textColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';

import { PRESALE_ORDER_STAGE, PRESALE_PAYMENT_MODE } from '../presale-enums';

/**
 * 预售订单.
 *
 * Read-only on purpose. Everything an operator *does* to a presale order — ship
 * it, refund it, close it — is done to the order itself, on 订单管理 and
 * 售后管理, and duplicating those buttons here would mean two screens that
 * disagree about what an order's status is. What this list adds is the one
 * question the ordinary order list cannot answer: what did we promise, and when
 * may the parcel leave.
 *
 * 最早发货时间 is frozen on the row when the money lands, so it keeps telling
 * the truth after an operator shortens the campaign's 发货承诺 for later buyers.
 */
export function PresaleOrdersPage() {
  return (
    <PageContainer subTitle="按活动查预售订单；发货时间以付款时冻结的承诺为准，改活动不影响已付款订单">
      <CrudTable
        route={presaleAdminOrderList}
        scrollX={1500}
        filters={[
          { kind: 'number', name: 'activityId', label: '活动 ID', min: 1 },
          {
            kind: 'select',
            name: 'stage',
            label: '阶段',
            multiple: true,
            options: Object.entries(PRESALE_ORDER_STAGE).map(([value, option]) => ({
              value,
              label: option.label,
            })),
          },
          { kind: 'number', name: 'userId', label: '用户 ID', min: 1 },
        ]}
        columns={[
          idColumn<PresaleOrderItem>({ dataIndex: 'orderId', title: '订单 ID', sortable: true }),
          codeColumn<PresaleOrderItem>({
            title: '订单号',
            dataIndex: 'orderNo',
            href: (row) => `/admin/orders/${row.orderId}`,
          }),
          textColumn<PresaleOrderItem>({
            title: '活动',
            dataIndex: 'activityTitle',
            ellipsis: true,
          }),
          {
            title: '买家',
            key: 'buyer',
            width: 150,
            render: (_value: unknown, row: PresaleOrderItem) => (
              <Typography.Text>
                {row.nickname ?? '—'}
                <Typography.Text type="secondary"> #{row.userId}</Typography.Text>
              </Typography.Text>
            ),
          },
          { title: '数量', dataIndex: 'quantity', key: 'quantity', width: 80 },
          moneyColumn<PresaleOrderItem>({ title: '应付', dataIndex: 'payableAmount' }),
          enumColumn<PresaleOrderItem, PresaleOrderItem['paymentMode']>({
            title: '付款方式',
            dataIndex: 'paymentMode',
            map: PRESALE_PAYMENT_MODE,
          }),
          {
            title: '阶段',
            key: 'stage',
            width: 140,
            render: (_value: unknown, row: PresaleOrderItem) => (
              <StatusTag value={row.stage} map={PRESALE_ORDER_STAGE} />
            ),
          },
          instantColumn<PresaleOrderItem>({ title: '付款时间', dataIndex: 'finalPaidAt' }),
          instantColumn<PresaleOrderItem>({
            title: '最早发货时间',
            dataIndex: 'shipNotBeforeAt',
            sortable: true,
          }),
          instantColumn<PresaleOrderItem>({
            title: '下单时间',
            dataIndex: 'createdAt',
            sortable: true,
          }),
        ]}
      />
    </PageContainer>
  );
}
