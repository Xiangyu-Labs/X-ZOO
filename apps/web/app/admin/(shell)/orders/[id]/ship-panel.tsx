'use client';

import { useMemo, useState } from 'react';
import { Alert, Button, Card, Empty, InputNumber, Space, Table, Typography } from 'antd';
import {
  orderAdminCancelShipment,
  orderAdminDetail,
  orderAdminList,
  orderAdminShip,
  orderAdminShipmentTracking,
  orderAdminShipments,
  orderAdminTimeline,
  orderAdminUpdateShipment,
} from '@shop/contracts/order/order.admin.contract';
import { expressCompanyPicker } from '@shop/contracts/shipping/shipping.express.contract';
import {
  shipBody,
  shipmentUpdateBody,
  type AdminOrderDetail,
  type Shipment,
} from '@shop/contracts/order/order.fulfil.schemas';

import { useRouteQuery } from '@/admin/api';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { InstantText } from '@/admin/kit/instant-text';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { StatusTag } from '@/admin/kit/status-tag';
import { Can } from '@/admin/session';

import { DELIVERY_MODE, SHIPMENT_STATUS } from '../order-enums';

/**
 * 发货 and what has already gone out.
 *
 * The only screen in the console with a real decision in it, so it is worth
 * saying what it is *not*: there is no 拆单. A partial dispatch is one more
 * `shipments` row covering some of the lines; the order never grows a child.
 * The quantity boxes below are bounded by `quantity - shipped - refunded`, and
 * the same bound is in the WHERE of the UPDATE the server runs, so a refund
 * approved while this form was open loses nothing — the server simply refuses
 * that line.
 */
export function ShipPanel({
  id,
  order,
  loading,
}: {
  id: string;
  order: AdminOrderDetail | null;
  loading: boolean;
}) {
  const shipModal = useFormModal<AdminOrderDetail>();
  const editModal = useFormModal<Shipment>();
  const companies = useRouteQuery(
    expressCompanyPicker,
    {},
    { enabled: shipModal.open || editModal.open },
  );
  const [lines, setLines] = useState<Record<string, number>>({});
  const editing = editModal.record;

  const outstanding = useMemo(
    () =>
      (order?.items ?? [])
        .map((item) => ({
          item,
          remaining: Math.max(0, item.quantity - item.shippedQuantity - item.refundedQuantity),
        }))
        .filter((entry) => entry.remaining > 0),
    [order],
  );

  // 拼团 not yet 成团: the server refuses the dispatch, so the button is not offered.
  const waitingForTeam =
    order !== null && order.groupbuyTeamStatus !== null && order.groupbuyTeamStatus !== 'succeeded';

  const shippable =
    order !== null &&
    order.status === 'paid' &&
    !waitingForTeam &&
    outstanding.some(
      (entry) =>
        entry.item.productKind === 'physical' || entry.item.productKind === 'virtual_manual',
    );

  const invalidate = [orderAdminDetail, orderAdminShipments, orderAdminTimeline, orderAdminList];

  // Every quantity set to 0 would send an empty `lines`, which the server reads
  // as 「剩余全部发出」 — the opposite of what the operator typed.
  const nothingSelected =
    outstanding.length > 0 &&
    outstanding.every((entry) => (lines[entry.item.id] ?? entry.remaining) === 0);
  const shipSchema = useMemo(
    () =>
      shipBody.refine(() => !nothingSelected, {
        message: '至少发出一件商品',
        path: ['lines'],
      }),
    [nothingSelected],
  );

  return (
    <Card
      size="small"
      title="发货"
      loading={loading}
      extra={
        shippable ? (
          <Can permission="order:shipment:write">
            <Button
              type="primary"
              onClick={() => {
                setLines({});
                shipModal.show(order);
              }}
            >
              发货
            </Button>
          </Can>
        ) : null
      }
    >
      {order && order.status === 'paid' && waitingForTeam ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            order.groupbuyTeamStatus === 'forming'
              ? '拼团中，成团后才能发货'
              : '拼团未成功，不能发货'
          }
          description={
            order.groupbuyTeamStatus === 'forming'
              ? '未成团的订单会自动退款。'
              : '这笔订单会按拼团失败退款。'
          }
        />
      ) : null}

      {order && order.status === 'paid' && !waitingForTeam && !shippable ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="没有可以手动发货的商品"
          description="卡密和优惠券商品由系统在支付后自动发货，不走这个按钮。"
        />
      ) : null}

      {order && order.shipments.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有发货记录" />
      ) : (
        <Table<Shipment>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={order?.shipments ?? []}
          expandable={{
            expandedRowRender: (row) => (
              <Space direction="vertical" size={2}>
                {row.lines.map((line) => (
                  <Typography.Text key={line.orderItemId} type="secondary">
                    {line.productName} {line.specText} × {line.quantity}
                  </Typography.Text>
                ))}
                {row.virtualContent ? (
                  <Typography.Paragraph type="secondary" style={{ whiteSpace: 'pre-wrap' }}>
                    {row.virtualContent}
                  </Typography.Paragraph>
                ) : null}
              </Space>
            ),
          }}
          columns={[
            { title: '发货单号', dataIndex: 'shipmentNo', width: 200 },
            {
              title: '方式',
              dataIndex: 'deliveryMode',
              width: 110,
              render: (value: Shipment['deliveryMode']) => (
                <StatusTag value={value} map={DELIVERY_MODE} />
              ),
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 100,
              render: (value: Shipment['status']) => (
                <StatusTag value={value} map={SHIPMENT_STATUS} />
              ),
            },
            {
              title: '物流',
              key: 'tracking',
              render: (_value: unknown, row: Shipment) =>
                row.trackingNo ? (
                  <Space size={4}>
                    <Typography.Text>{row.expressCompanyName ?? '—'}</Typography.Text>
                    <Typography.Text copyable>{row.trackingNo}</Typography.Text>
                    <TrackingLink shipmentId={row.id} />
                  </Space>
                ) : (
                  <Typography.Text type="secondary">
                    {row.courierName ? `${row.courierName} ${row.courierPhone ?? ''}` : '—'}
                  </Typography.Text>
                ),
            },
            {
              title: '发货时间',
              dataIndex: 'dispatchedAt',
              width: 170,
              render: (value: string) => <InstantText value={value} />,
            },
            {
              title: '操作',
              key: 'actions',
              width: 150,
              render: (_value: unknown, row: Shipment) =>
                row.status === 'dispatched' ? (
                  <Can permission="order:shipment:write">
                    <Space size={0}>
                      {row.deliveryMode === 'virtual' ? null : (
                        <Button type="link" size="small" onClick={() => editModal.show(row)}>
                          修改物流
                        </Button>
                      )}
                      {order?.status === 'paid' ? (
                        <ConfirmButton
                          route={orderAdminCancelShipment}
                          input={{ params: { id: row.id }, body: {} }}
                          title={`确认撤销发货单 ${row.shipmentNo}？`}
                          description="单上的商品回到待发货，可以重新发货。整单都已发出后不能撤销，运单填错请用「修改物流」。"
                          invalidate={invalidate}
                          successMessage="已撤销"
                          buttonProps={{ type: 'link', size: 'small', danger: true }}
                        >
                          撤销
                        </ConfirmButton>
                      ) : null}
                    </Space>
                  </Can>
                ) : null,
            },
          ]}
        />
      )}

      <ModalForm
        {...shipModal.props}
        title="发货"
        schema={shipSchema}
        columns={2}
        initialValues={{ deliveryMode: 'express', lines: [] }}
        fields={[
          {
            kind: 'radio',
            name: 'deliveryMode',
            label: '发货方式',
            optionType: 'button',
            span: 24,
            options: [
              { value: 'express', label: '快递发货' },
              { value: 'merchant_delivery', label: '商家配送' },
              { value: 'virtual', label: '虚拟发货' },
            ],
          },
          {
            kind: 'select',
            name: 'expressCompanyId',
            label: '物流公司',
            visibleWhen: (values) => values.deliveryMode === 'express',
            options: (companies.data?.items ?? []).map((company) => ({
              value: company.id,
              label: company.name,
            })),
          },
          {
            kind: 'text',
            name: 'trackingNo',
            label: '运单号',
            visibleWhen: (values) => values.deliveryMode === 'express',
          },
          {
            kind: 'text',
            name: 'courierName',
            label: '配送人',
            visibleWhen: (values) => values.deliveryMode === 'merchant_delivery',
          },
          {
            kind: 'text',
            name: 'courierPhone',
            label: '配送电话',
            visibleWhen: (values) => values.deliveryMode === 'merchant_delivery',
          },
          {
            kind: 'textarea',
            name: 'virtualContent',
            label: '发货内容',
            span: 24,
            rows: 3,
            visibleWhen: (values) => values.deliveryMode === 'virtual',
            help: '买家会看到这段文字。卡密和优惠券商品不走这里，系统已经自动发过了。',
          },
          {
            kind: 'custom',
            name: 'lines',
            label: '发货商品',
            span: 24,
            help: '留空表示把剩余的全部发出；填了数量就是部分发货。',
            render: () => (
              <Table
                rowKey={(entry) => entry.item.id}
                size="small"
                pagination={false}
                dataSource={outstanding}
                columns={[
                  {
                    title: '商品',
                    key: 'name',
                    render: (_value: unknown, entry: (typeof outstanding)[number]) => (
                      <Typography.Text ellipsis>
                        {entry.item.productName} {entry.item.specText}
                      </Typography.Text>
                    ),
                  },
                  {
                    title: '待发',
                    key: 'remaining',
                    width: 80,
                    render: (_value: unknown, entry: (typeof outstanding)[number]) =>
                      entry.remaining,
                  },
                  {
                    title: '本次发货',
                    key: 'quantity',
                    width: 140,
                    render: (_value: unknown, entry: (typeof outstanding)[number]) => (
                      <InputNumber
                        min={0}
                        max={entry.remaining}
                        value={lines[entry.item.id] ?? entry.remaining}
                        onChange={(value) =>
                          setLines((current) => ({
                            ...current,
                            [entry.item.id]: Number(value ?? 0),
                          }))
                        }
                      />
                    ),
                  },
                ]}
              />
            ),
          },
        ]}
        route={orderAdminShip}
        toInput={(values) => ({
          params: { id },
          body: {
            ...values,
            lines: outstanding
              .map((entry) => ({
                orderItemId: entry.item.id,
                quantity: lines[entry.item.id] ?? entry.remaining,
              }))
              // A line set to zero is simply not in this dispatch. Sending
              // every line at its full remaining quantity would be the same as
              // an empty list, so we keep the payload honest instead.
              .filter((line) => line.quantity > 0),
          },
        })}
        invalidate={invalidate}
        successMessage="已发货"
      />

      <ModalForm
        {...editModal.props}
        title="修改物流"
        schema={shipmentUpdateBody}
        initialValues={
          editing
            ? editing.deliveryMode === 'express'
              ? {
                  ...(editing.expressCompanyId
                    ? { expressCompanyId: editing.expressCompanyId }
                    : {}),
                  ...(editing.trackingNo ? { trackingNo: editing.trackingNo } : {}),
                }
              : {
                  ...(editing.courierName ? { courierName: editing.courierName } : {}),
                  ...(editing.courierPhone ? { courierPhone: editing.courierPhone } : {}),
                }
            : undefined
        }
        fields={
          editing?.deliveryMode === 'merchant_delivery'
            ? [
                { kind: 'text', name: 'courierName', label: '配送人' },
                { kind: 'text', name: 'courierPhone', label: '配送电话' },
              ]
            : [
                {
                  kind: 'select',
                  name: 'expressCompanyId',
                  label: '物流公司',
                  options: (companies.data?.items ?? []).map((company) => ({
                    value: company.id,
                    label: company.name,
                  })),
                },
                { kind: 'text', name: 'trackingNo', label: '运单号' },
              ]
        }
        route={orderAdminUpdateShipment}
        toInput={(values) => ({ params: { id: editing?.id ?? '' }, body: values })}
        invalidate={invalidate}
        successMessage="物流信息已更新"
      />
    </Card>
  );
}

/** The courier feed. `available: false` while no tracking provider is registered. */
function TrackingLink({ shipmentId }: { shipmentId: string }) {
  const [open, setOpen] = useState(false);
  const tracking = useRouteQuery(
    orderAdminShipmentTracking,
    { params: { id: shipmentId } },
    { enabled: open },
  );

  if (!open) {
    return (
      <Button type="link" size="small" onClick={() => setOpen(true)}>
        查物流
      </Button>
    );
  }
  if (tracking.isPending) return <Typography.Text type="secondary">查询中…</Typography.Text>;
  if (!tracking.data?.available) {
    return <Typography.Text type="secondary">未接入物流查询</Typography.Text>;
  }
  return (
    <Space direction="vertical" size={0}>
      {tracking.data.traces.map((trace) => (
        <Typography.Text key={trace.at} type="secondary">
          <InstantText value={trace.at} /> {trace.context}
        </Typography.Text>
      ))}
    </Space>
  );
}
