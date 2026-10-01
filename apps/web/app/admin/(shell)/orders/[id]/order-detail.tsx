'use client';

import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Row,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import { catalogAdminProductDetail } from '@shop/contracts/catalog/catalog.product.admin.contract';
import {
  orderAdminAdjustPrice,
  orderAdminConfirmReceipt,
  orderAdminDetail,
  orderAdminList,
  orderAdminRemark,
  orderAdminTimeline,
  orderAdminUpdateAddress,
} from '@shop/contracts/order/order.admin.contract';
import {
  orderAddressBody,
  orderPriceBody,
  orderRemarkBody,
  type AdminOrderDetail,
} from '@shop/contracts/order/order.fulfil.schemas';
import type { OrderItem } from '@shop/contracts/order/schemas';
import { refundAdminList } from '@shop/contracts/refund/refund.admin.contract';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { z } from 'zod';

import { errorMessage, useRouteQuery } from '@/admin/api';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { DescriptionsCard } from '@/admin/kit/descriptions-card';
import { InstantText } from '@/admin/kit/instant-text';
import { ModalForm, useFormModal } from '@/admin/kit/form/modal-form';
import { MoneyText } from '@/admin/kit/money-text';
import { PageContainer } from '@/admin/kit/page-container';
import { StatusTag } from '@/admin/kit/status-tag';
import { CodeText } from '@/admin/kit/table/columns';
import { Thumbnail } from '@/admin/kit/thumbnail';
import { Can, useCan } from '@/admin/session';

import {
  CHANGE_TYPE,
  FULFILLMENT_STATUS,
  OPERATOR_KIND,
  ORDER_KIND,
  ORDER_STATUS,
  REFUND_STATUS,
} from '../order-enums';
import { loadRegionOptions, REGION_CACHE_KEY } from './region-options';
import { ShipPanel } from './ship-panel';

/** 修改收货地址 picks 省 / 市 / 区 as one path; the body still carries three names. */
const addressForm = orderAddressBody
  .omit({ province: true, city: true, district: true })
  .extend({ region: z.array(z.string()).min(2, '请选择所在地区') });

/**
 * The list the operator came from, rebuilt from its query string only — never a
 * path taken from the URL, so `?list=` cannot send anyone off the console.
 */
export function listHrefOf(list: string | null): string {
  const query = list ? new URLSearchParams(list).toString() : '';
  return query ? `/admin/orders?${query}` : '/admin/orders';
}

/**
 * 订单详情 — the screen an operator spends their day on.
 *
 * Laid out as the questions they actually ask, in order: *what state is this
 * in*, *what did they buy*, *has it gone out*, *what happened to it*. The
 * actions sit next to the panel they change rather than in one toolbar, so
 * 发货 is beside the shipments and 改价 is beside the money.
 */
export function OrderDetailPage({ id }: { id: string }) {
  const order = useRouteQuery(orderAdminDetail, { params: { id } });
  const timeline = useRouteQuery(orderAdminTimeline, { params: { id } });
  const remarkModal = useFormModal<AdminOrderDetail>();
  const priceModal = useFormModal<AdminOrderDetail>();
  const addressModal = useFormModal<AdminOrderDetail>();

  const listHref = listHrefOf(useSearchParams().get('list'));
  const can = useCan();
  const canReadRefunds = can(refundAdminList.permission);
  const canReadProducts = can(catalogAdminProductDetail.permission);

  const data = order.data;
  const invalidate = [orderAdminDetail, orderAdminTimeline, orderAdminList];

  if (order.isError) {
    return (
      <PageContainer
        title="订单详情"
        breadcrumb={[{ label: '订单', href: listHref }, { label: '详情' }]}
      >
        <Alert
          type="error"
          showIcon
          message="订单加载失败"
          description={errorMessage(order.error, '订单加载失败，请重试')}
          action={
            <Button size="small" onClick={() => order.refetch()}>
              重试
            </Button>
          }
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer
      title={data ? `订单 ${data.orderNo}` : '订单详情'}
      breadcrumb={[{ label: '订单', href: listHref }, { label: data?.orderNo ?? '详情' }]}
      extra={
        data ? (
          <Space>
            <Can permission="order:order:write">
              <Button onClick={() => remarkModal.show(data)}>备注</Button>
            </Can>
            {data.status === 'pending_payment' ? (
              <Can permission="order:order:reprice">
                <Button onClick={() => priceModal.show(data)}>改价</Button>
              </Can>
            ) : null}
            {data.fulfillmentStatus === 'unfulfilled' &&
            (data.status === 'pending_payment' || data.status === 'paid') ? (
              <Can permission="order:order:write">
                <Button onClick={() => addressModal.show(data)}>修改地址</Button>
              </Can>
            ) : null}
            {data.status === 'shipped' ? (
              <Can permission="order:order:write">
                <ConfirmButton
                  route={orderAdminConfirmReceipt}
                  input={{ params: { id }, body: {} }}
                  title="确认该订单已收货？"
                  description="买家自己确认、系统自动确认和这个按钮做的是同一件事，谁先到算谁的。"
                  invalidate={invalidate}
                  successMessage="已确认收货"
                  buttonProps={{ type: 'primary' }}
                >
                  确认收货
                </ConfirmButton>
              </Can>
            ) : null}
          </Space>
        ) : null
      }
    >
      {data?.deletedAt ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="该订单已被删除"
          description={<InstantText value={data.deletedAt} />}
        />
      ) : null}

      <Row gutter={[16, 16]}>
        <Col xs={24} xxl={16}>
          <Card
            size="small"
            title="订单状态"
            loading={order.isPending}
            style={{ marginBottom: 16 }}
          >
            <Descriptions column={{ xs: 1, sm: 2, lg: 3 }} size="small">
              <Descriptions.Item label="订单号">
                <CodeText value={data?.orderNo} />
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                <StatusTag value={data?.status} map={ORDER_STATUS} />
              </Descriptions.Item>
              <Descriptions.Item label="发货">
                <StatusTag value={data?.fulfillmentStatus} map={FULFILLMENT_STATUS} />
              </Descriptions.Item>
              <Descriptions.Item label="售后">
                {data && data.refundStatus !== 'none' && canReadRefunds ? (
                  <Link href={`/admin/trade/refunds?keyword=${encodeURIComponent(data.orderNo)}`}>
                    <StatusTag value={data.refundStatus} map={REFUND_STATUS} />
                  </Link>
                ) : (
                  <StatusTag value={data?.refundStatus} map={REFUND_STATUS} />
                )}
              </Descriptions.Item>
              <Descriptions.Item label="类型">
                <StatusTag value={data?.kind} map={ORDER_KIND} />
              </Descriptions.Item>
              <Descriptions.Item label="下单">
                <InstantText value={data?.createdAt ?? null} />
              </Descriptions.Item>
              <Descriptions.Item label="支付">
                <InstantText value={data?.paidAt ?? null} />
              </Descriptions.Item>
              <Descriptions.Item label="发货">
                <InstantText value={data?.shippedAt ?? null} />
              </Descriptions.Item>
              <Descriptions.Item label="收货">
                <InstantText value={data?.receivedAt ?? null} />
              </Descriptions.Item>
              <Descriptions.Item label="自动确认收货">
                <InstantText value={data?.autoReceiveAt ?? null} />
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <Card size="small" title="商品" loading={order.isPending} style={{ marginBottom: 16 }}>
            <Table<OrderItem>
              rowKey="id"
              size="small"
              pagination={false}
              // The fixed columns add up to 690px; the product keeps 220 of its own and the
              // table scrolls inside its card rather than squeezing a name to one character a line.
              scroll={{ x: 910 }}
              dataSource={data?.items ?? []}
              columns={[
                {
                  title: '商品',
                  key: 'product',
                  width: 220,
                  render: (_value: unknown, row: OrderItem) => (
                    <Space size={8}>
                      <Thumbnail src={row.skuImageUrl ?? row.productImageUrl} size={40} />
                      {canReadProducts ? (
                        <Link href={`/admin/catalog/products/${row.productId}`}>
                          {row.productName}
                        </Link>
                      ) : (
                        row.productName
                      )}
                    </Space>
                  ),
                },
                { title: '规格', dataIndex: 'specText', width: 160, ellipsis: true },
                {
                  title: '单价',
                  dataIndex: 'unitPrice',
                  width: 100,
                  render: (value: string) => <MoneyText value={value} />,
                },
                { title: '数量', dataIndex: 'quantity', width: 70 },
                {
                  title: '已发',
                  key: 'shipped',
                  width: 90,
                  render: (_value: unknown, row: OrderItem) => (
                    <Typography.Text
                      type={row.shippedQuantity < row.quantity ? 'warning' : 'success'}
                    >
                      {row.shippedQuantity} / {row.quantity}
                    </Typography.Text>
                  ),
                },
                {
                  title: '已退',
                  dataIndex: 'refundedQuantity',
                  width: 70,
                  render: (value: number) => (value > 0 ? <Tag color="error">{value}</Tag> : '—'),
                },
                {
                  title: '优惠',
                  dataIndex: 'discountAmount',
                  width: 100,
                  render: (value: string) => <MoneyText value={value} />,
                },
                {
                  title: '小计',
                  dataIndex: 'totalAmount',
                  width: 100,
                  render: (value: string) => <MoneyText value={value} strong />,
                },
              ]}
              summary={() =>
                data ? (
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0} colSpan={7}>
                      <Space size="large">
                        <span>
                          商品 <MoneyText value={data.itemsAmount} />
                        </span>
                        <span>
                          运费 <MoneyText value={data.freightAmount} />
                        </span>
                        <span>
                          优惠 <MoneyText value={data.couponDiscount} />
                        </span>
                      </Space>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={7}>
                      <MoneyText value={data.payableAmount} strong />
                    </Table.Summary.Cell>
                  </Table.Summary.Row>
                ) : null
              }
            />
          </Card>

          <ShipPanel id={id} order={data ?? null} loading={order.isPending} />

          <Card
            size="small"
            title="操作记录"
            loading={timeline.isPending}
            style={{ marginTop: 16 }}
          >
            <Timeline
              items={(timeline.data?.items ?? []).map((entry) => ({
                color: entry.changeType.startsWith('refund') ? 'red' : 'blue',
                children: (
                  <Space direction="vertical" size={0}>
                    <Space size={8}>
                      <Typography.Text strong>{CHANGE_TYPE[entry.changeType]}</Typography.Text>
                      <StatusTag value={entry.operatorKind} map={OPERATOR_KIND} />
                      {entry.operatorName ? (
                        <Typography.Text type="secondary">{entry.operatorName}</Typography.Text>
                      ) : null}
                    </Space>
                    {entry.message ? (
                      <Typography.Text type="secondary">{entry.message}</Typography.Text>
                    ) : null}
                    <Typography.Text type="secondary">
                      <InstantText value={entry.createdAt} />
                    </Typography.Text>
                  </Space>
                ),
              }))}
            />
          </Card>
        </Col>

        <Col xs={24} xxl={8}>
          {/* Three across while the page is too narrow for two columns, stacked beside the items from 1600px. */}
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={8} xxl={24}>
              <DescriptionsCard
                title="买家"
                loading={order.isPending}
                column={1}
                items={[
                  { label: '昵称', value: data?.user.nickname ?? '—' },
                  { label: '用户 ID', value: <CodeText value={data?.user.id} /> },
                  { label: '手机号', value: data?.user.phone ?? '—' },
                  { label: '下单端', value: data?.platform ?? '—' },
                ]}
              />
            </Col>
            <Col xs={24} lg={8} xxl={24}>
              <DescriptionsCard
                title="收货信息"
                loading={order.isPending}
                column={1}
                items={[
                  { label: '收货人', value: data?.receiver.name ?? '—' },
                  { label: '电话', value: data?.receiver.phone ?? '—' },
                  {
                    label: '地址',
                    value: data
                      ? `${data.receiver.province}${data.receiver.city}${data.receiver.district ?? ''}${data.receiver.detail}`
                      : '—',
                  },
                  { label: '买家备注', value: data?.buyerRemark ?? '—' },
                  { label: '商家备注', value: data?.adminRemark ?? '—' },
                ]}
              />
            </Col>
            <Col xs={24} lg={8} xxl={24}>
              <DescriptionsCard
                title="金额"
                loading={order.isPending}
                column={1}
                items={[
                  { label: '应付', value: <MoneyText value={data?.payableAmount ?? null} /> },
                  { label: '实付', value: <MoneyText value={data?.paidAmount ?? null} /> },
                  { label: '已退款', value: <MoneyText value={data?.refundedAmount ?? null} /> },
                  { label: '成本', value: <MoneyText value={data?.costAmount ?? null} /> },
                  { label: '交易号', value: <CodeText value={data?.transactionNo ?? undefined} /> },
                ]}
              />
            </Col>
          </Row>
        </Col>
      </Row>

      <ModalForm
        {...remarkModal.props}
        title="商家备注"
        schema={orderRemarkBody}
        fields={[{ kind: 'textarea', name: 'adminRemark', label: '备注', rows: 4, maxLength: 512 }]}
        initialValues={{ adminRemark: data?.adminRemark ?? '' }}
        route={orderAdminRemark}
        toInput={(values) => ({ params: { id }, body: values })}
        invalidate={invalidate}
        successMessage="已保存"
      />

      <ModalForm
        {...priceModal.props}
        title="改价"
        schema={orderPriceBody}
        fields={[
          {
            kind: 'money',
            name: 'operatorDiscount',
            label: '再优惠',
            help: '从商品总额里减掉的金额，会按行重新分摊。它替换上次改价的优惠而不是叠加，填 0.00 撤销改价。买家手里未付的支付单会先被关闭。',
          },
          { kind: 'money', name: 'freightAmount', label: '运费', help: '留空表示不改运费。' },
          { kind: 'text', name: 'reason', label: '原因', maxLength: 255 },
        ]}
        initialValues={{ operatorDiscount: data?.operatorDiscount ?? '0.00' }}
        route={orderAdminAdjustPrice}
        toInput={(values) => ({ params: { id }, body: values })}
        invalidate={invalidate}
        successMessage="已改价"
      />

      <ModalForm
        {...addressModal.props}
        title="修改收货地址"
        schema={addressForm}
        columns={2}
        fields={[
          { kind: 'text', name: 'name', label: '收货人' },
          { kind: 'text', name: 'phone', label: '电话' },
          {
            kind: 'cascader',
            name: 'region',
            label: '所在地区',
            span: 24,
            loadOptions: loadRegionOptions,
            cacheKey: REGION_CACHE_KEY,
            changeOnSelect: true,
            placeholder: '省 / 市 / 区',
          },
          { kind: 'text', name: 'detail', label: '详细地址', span: 24 },
          { kind: 'text', name: 'postCode', label: '邮编' },
        ]}
        initialValues={
          data
            ? {
                name: data.receiver.name,
                phone: data.receiver.phone,
                region: [
                  data.receiver.province,
                  data.receiver.city,
                  data.receiver.district ?? '',
                ].filter(Boolean),
                detail: data.receiver.detail,
                postCode: data.receiver.postCode ?? '',
              }
            : undefined
        }
        route={orderAdminUpdateAddress}
        toInput={({ region, ...values }) => {
          const [province = '', city = '', district] = region;
          return {
            params: { id },
            body: { ...values, province, city, ...(district ? { district } : {}) },
          };
        }}
        invalidate={invalidate}
        successMessage="已修改"
      />
    </PageContainer>
  );
}
