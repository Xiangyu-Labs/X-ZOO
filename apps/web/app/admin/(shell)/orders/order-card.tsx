'use client';

import { PictureOutlined } from '@ant-design/icons';
import { refundAdminList } from '@shop/contracts/refund/refund.admin.contract';
import type { AdminOrderListItem } from '@shop/contracts/order/order.fulfil.schemas';
import type { OrderItem } from '@shop/contracts/order/schemas';
import { Button, Card, Checkbox, Col, Flex, Row, Space, Tag, Tooltip, Typography } from 'antd';
import Link from 'next/link';
import { useState, type CSSProperties, type ReactNode } from 'react';

import { InstantText } from '@/admin/kit/instant-text';
import { MoneyText } from '@/admin/kit/money-text';
import { StatusTag } from '@/admin/kit/status-tag';
import { CodeText } from '@/admin/kit/table/columns';
import { Thumbnail } from '@/admin/kit/thumbnail';
import { useCan } from '@/admin/session';

import { orderActionOf, teamForming } from './order-actions';
import { FULFILLMENT_STATUS, ORDER_KIND, ORDER_STATUS, REFUND_STATUS } from './order-enums';

const Text = Typography.Text;

export interface OrderCardProps {
  row: AdminOrderListItem;
  detailHref: string;
  selected: boolean;
  selectable: boolean;
  onToggle: () => void;
  onShip: (row: AdminOrderListItem) => void;
  onLogistics: (row: AdminOrderListItem) => void;
}

/**
 * One order row as a card, following the console's information order:
 * *what/when*, *what was bought*, *who/where*, *how much*, *what state and what
 * to do next*. The card is the whole row — the list no longer repeats 订单号,
 * 金额 and 操作 in six columns that have to be read across.
 */
export function OrderCard({
  row,
  detailHref,
  selected,
  selectable,
  onToggle,
  onShip,
  onLogistics,
}: OrderCardProps) {
  const address = `${row.receiver.province}${row.receiver.city}${row.receiver.district ?? ''}${row.receiver.detail}`;
  const refundHref = `/admin/trade/refunds?keyword=${encodeURIComponent(row.orderNo)}`;

  return (
    <Card
      size="small"
      style={{ borderRadius: 8, overflow: 'hidden' }}
      styles={{ body: { padding: 0 } }}
    >
      <Flex
        align="center"
        gap={12}
        wrap
        style={{
          padding: '10px 16px',
          background: 'var(--ant-color-fill-quaternary)',
          borderBottom: '1px solid var(--ant-color-border-secondary)',
        }}
      >
        {selectable ? (
          <Checkbox
            aria-label={`选择订单 ${row.orderNo}`}
            checked={selected}
            onChange={() => onToggle()}
          />
        ) : null}
        <Space size={4} wrap>
          <Text type="secondary">订单类型</Text>
          <StatusTag value={row.kind} map={ORDER_KIND} />
        </Space>
        <Space size={4}>
          <Text type="secondary">下单时间</Text>
          <InstantText value={row.createdAt} />
        </Space>
        <Space size={4}>
          <Text type="secondary">订单编号</Text>
          <CodeText value={row.orderNo} href={detailHref} />
        </Space>
        <div style={{ flex: 1, minWidth: 8 }} />
        {row.adminRemark ? (
          <Tooltip title={row.adminRemark}>
            <Tag color="gold" bordered={false}>
              商家备注
            </Tag>
          </Tooltip>
        ) : null}
        <Link href={detailHref} style={{ whiteSpace: 'nowrap' }}>
          订单详情
        </Link>
      </Flex>

      <div style={{ padding: 16 }}>
        <Row gutter={[24, 16]}>
          <Col xs={24} xl={12}>
            <OrderItems items={row.items} />
            <Flex
              justify="space-between"
              gap={8}
              wrap
              style={{
                marginTop: 12,
                paddingTop: 10,
                borderTop: '1px dashed var(--ant-color-border-secondary)',
              }}
            >
              <Text type="secondary">共 {row.totalQuantity} 件商品</Text>
              <Text type="secondary">发货时间：{shippingTime(row)}</Text>
            </Flex>
          </Col>

          <Col xs={24} sm={12} xl={5}>
            <ContactBlock row={row} address={address} />
          </Col>

          <Col xs={12} sm={6} xl={4}>
            <Amounts row={row} />
          </Col>

          <Col xs={12} sm={6} xl={3}>
            <StatusActions
              row={row}
              refundHref={refundHref}
              onShip={onShip}
              onLogistics={onLogistics}
            />
          </Col>
        </Row>
      </div>
    </Card>
  );
}

const PREVIEW_ITEMS = 2;

function OrderItems({ items }: { items: readonly OrderItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, PREVIEW_ITEMS);

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {shown.map((item) => (
        <ItemLine key={item.id} item={item} />
      ))}
      {items.length > PREVIEW_ITEMS ? (
        <Button
          type="link"
          size="small"
          style={{ paddingInline: 0, alignSelf: 'flex-start' }}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起' : `展开其余 ${items.length - PREVIEW_ITEMS} 件`}
        </Button>
      ) : null}
    </Space>
  );
}

function ItemLine({ item }: { item: OrderItem }) {
  const image = item.skuImageUrl ?? item.productImageUrl;

  return (
    <Flex gap={12} align="flex-start" wrap>
      {image ? (
        <Thumbnail src={image} size={56} />
      ) : (
        <div style={IMAGE_PLACEHOLDER} aria-hidden>
          <PictureOutlined />
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text strong ellipsis style={{ display: 'block' }}>
          {item.productName}
        </Text>
        {item.specText ? (
          <Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>
            {item.specText}
          </Text>
        ) : null}
      </div>
      <div style={{ width: 100, flexShrink: 0, textAlign: 'right' }}>
        <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
          单价
        </Text>
        <MoneyText value={item.unitPrice} />
      </div>
      <div style={{ width: 56, flexShrink: 0, textAlign: 'right' }}>
        <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
          数量
        </Text>
        <Text>× {item.quantity}</Text>
      </div>
      <div style={{ width: 96, flexShrink: 0, textAlign: 'right' }}>
        <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
          小计
        </Text>
        <MoneyText value={item.totalAmount} strong />
      </div>
    </Flex>
  );
}

function ContactBlock({ row, address }: { row: AdminOrderListItem; address: string }) {
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <div>
        <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
          买家
        </Text>
        <Text ellipsis style={{ display: 'block' }}>
          {row.user.nickname}
          <Text type="secondary"> #{row.user.id}</Text>
        </Text>
      </div>
      <div>
        <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
          收货人
        </Text>
        <Text ellipsis style={{ display: 'block' }}>
          {row.receiver.name} {row.receiver.phone}
        </Text>
        <Tooltip title={address}>
          <Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>
            {address}
          </Text>
        </Tooltip>
      </div>
    </Space>
  );
}

function Amounts({ row }: { row: AdminOrderListItem }) {
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <div>
        <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
          应付金额
        </Text>
        <MoneyText value={row.payableAmount} strong />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {' '}
          含运费 <MoneyText value={row.freightAmount} symbol="" />
        </Text>
      </div>
      <div>
        <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
          实付金额
        </Text>
        {row.paidAmount === null ? (
          <Text type="secondary">未支付</Text>
        ) : (
          <>
            <MoneyText value={row.paidAmount} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {' '}
              优惠 <MoneyText value={row.couponDiscount} symbol="" />
            </Text>
          </>
        )}
      </div>
      {row.refundedAmount !== '0.00' ? (
        <div>
          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
            已退款
          </Text>
          <MoneyText value={row.refundedAmount} />
        </div>
      ) : null}
    </Space>
  );
}

function StatusActions({
  row,
  refundHref,
  onShip,
  onLogistics,
}: {
  row: AdminOrderListItem;
  refundHref: string;
  onShip: (row: AdminOrderListItem) => void;
  onLogistics: (row: AdminOrderListItem) => void;
}) {
  const can = useCan();
  const action = orderActionOf(row);
  const showShip = action === 'ship' && can('order:shipment:write');
  const showLogistics = action === 'logistics';
  const showAftersale = action === 'aftersale' && can(refundAdminList.permission);

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <div>
        <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
          订单状态
        </Text>
        <Space size={[4, 4]} wrap style={{ marginTop: 4 }}>
          <StatusTag value={row.status} map={ORDER_STATUS} />
          {teamForming(row) ? (
            <Tag
              color={row.groupbuyTeamStatus === 'forming' ? 'orange' : 'default'}
              bordered={false}
            >
              {row.groupbuyTeamStatus === 'forming' ? '拼团中' : '未成团'}
            </Tag>
          ) : null}
          {row.fulfillmentStatus === 'partially_fulfilled' ? (
            <StatusTag value={row.fulfillmentStatus} map={FULFILLMENT_STATUS} />
          ) : null}
          {row.refundStatus === 'requested' || row.refundStatus === 'partially_refunded' ? (
            <StatusTag value={row.refundStatus} map={REFUND_STATUS} />
          ) : null}
        </Space>
      </div>
      <div>
        <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
          订单操作
        </Text>
        <div style={{ marginTop: 4 }}>
          {showShip ? (
            <Button type="primary" size="small" onClick={() => onShip(row)}>
              发货
            </Button>
          ) : null}
          {showLogistics ? (
            <Button
              type="link"
              size="small"
              style={{ paddingInline: 0 }}
              onClick={() => onLogistics(row)}
            >
              物流详情
            </Button>
          ) : null}
          {showAftersale ? (
            <Link href={refundHref} style={{ color: 'var(--ant-color-primary)' }}>
              售后详情
            </Link>
          ) : null}
          {!showShip && !showLogistics && !showAftersale ? <Text type="secondary">—</Text> : null}
        </div>
      </div>
    </Space>
  );
}

function shippingTime(row: AdminOrderListItem): ReactNode {
  if (row.shippedAt !== null) return <InstantText value={row.shippedAt} />;
  if (teamForming(row)) {
    return row.groupbuyTeamStatus === 'forming' ? '拼团中，成团后发货' : '未成团，暂不发货';
  }
  if (row.kind === 'presale') return '按预售活动承诺时间发货';
  if (row.fulfillmentStatus === 'partially_fulfilled') return '部分发货，待发完';
  return '未发货';
}

const IMAGE_PLACEHOLDER: CSSProperties = {
  width: 56,
  height: 56,
  borderRadius: 4,
  flexShrink: 0,
  background: 'var(--ant-color-fill-quaternary)',
  color: 'var(--ant-color-text-quaternary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
