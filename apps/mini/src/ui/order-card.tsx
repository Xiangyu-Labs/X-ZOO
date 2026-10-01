import type { OrderItem, StorefrontOrderListItem } from '@shop/contracts/order/schemas';
import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { orderPrices } from '@/lib/order-price';
import { serverNow } from '@/lib/server-clock';
import { formatSpec } from '@/lib/spec';
import { navigate } from '@/platform';
import { Button } from './button';
import { Countdown } from './countdown';
import { Image } from './image';
import { orderActions, orderStatusText, type OrderActionKey } from './order-actions';
import { Price } from './price';
import { Pressable } from './pressable';
import { Tag } from './tag';
import './order-card.scss';

const MAX_ROWS = 3;

/**
 * One bought line: picture, name, spec, unit price and quantity (design.md `OrderItemRow`).
 * `price` is what the shopper paid per unit when that is not `unitPrice` (an activity line,
 * `orderPrices`).
 */
export function OrderItemRow({
  item,
  price,
  note,
}: {
  item: Pick<
    OrderItem,
    'productName' | 'productImageUrl' | 'skuImageUrl' | 'specText' | 'unitPrice' | 'quantity'
  >;
  price?: string | undefined;
  /** A small tag under the spec: 「退款中」. */
  note?: string | undefined;
}) {
  return (
    <View className="shop-order-row">
      {/* The wrapper sets the width: Image's ratio padding is a share of its parent's width. */}
      <View className="shop-order-row__image">
        <Image src={item.skuImageUrl ?? item.productImageUrl} radius="sm" size="small" />
      </View>
      <View className="shop-order-row__info">
        <Text className="shop-order-row__name">{item.productName}</Text>
        {item.specText ? (
          <Text className="shop-order-row__spec">{formatSpec(item.specText)}</Text>
        ) : null}
        {note ? (
          <Tag tone="warning" className="shop-order-row__note">
            {note}
          </Tag>
        ) : null}
      </View>
      <View className="shop-order-row__side">
        <Price value={price ?? item.unitPrice} size="sm" tone="text" />
        <Text className="shop-order-row__qty">×{item.quantity}</Text>
      </View>
    </View>
  );
}

export interface OrderCardProps {
  order: StorefrontOrderListItem;
  onAction: (key: OrderActionKey, order: StorefrontOrderListItem) => void;
  /** Opens the order by default. */
  onClick?: (() => void) | undefined;
  /** Which action is in flight (its button spins). */
  busy?: OrderActionKey | undefined;
  /**
   * An unpaid order's time to pay ran out while shown: the list reads it again (the server
   * closes it). Until then the card says 「支付已超时」 and offers no 立即付款.
   */
  onExpire?: (() => void) | undefined;
  className?: string | undefined;
}

const KIND_TAG = { groupbuy: '拼团', presale: '预售' } as const;

/**
 * An order in 我的订单 (design.md §4.4): status, up to three lines then 「共 N 件」, the amount
 * paid, and the buttons `orderActions` gives it. An unpaid order counts down to its expiry.
 */
export function OrderCard({ order, onAction, onClick, busy, onExpire, className }: OrderCardProps) {
  // The deadline the countdown reached here; one already past when drawn counts too.
  const [endedAt, setEndedAt] = useState<string | null>(null);
  const expiry = order.status === 'pending_payment' ? order.payExpiresAt : null;
  const expired = expiry !== null && (endedAt === expiry || Date.parse(expiry) <= serverNow());
  const actions = orderActions(order).filter((action) => !(expired && action.key === 'pay'));
  const open = onClick ?? (() => void navigate({ route: 'order', params: { id: order.id } }));
  const shown = order.items.slice(0, MAX_ROWS);
  const { unitPrices } = orderPrices(order);
  const paid = order.paidAmount ?? order.payableAmount;
  // Any request still being handled, including one after an earlier partial refund.
  const refunding = order.hasOpenRefund;

  return (
    <View className={cx('shop-order', className)}>
      <Pressable
        label={`订单 ${order.orderNo}，${orderStatusText(order)}`}
        role="link"
        onClick={open}
      >
        <View className="shop-order__head">
          <View className="shop-order__head-left">
            {order.kind !== 'normal' ? <Tag tone="primary">{KIND_TAG[order.kind]}</Tag> : null}
            <Text className="shop-order__no">订单号 {order.orderNo}</Text>
          </View>
          <Text
            className={cx(
              'shop-order__status',
              order.status === 'pending_payment' && 'shop-order__status--alert',
            )}
          >
            {refunding ? '售后中' : orderStatusText(order)}
          </Text>
        </View>
        {shown.map((item) => (
          <OrderItemRow key={item.id} item={item} price={unitPrices[item.id]} />
        ))}
        {order.items.length > MAX_ROWS ? (
          <Text className="shop-order__more">还有 {order.items.length - MAX_ROWS} 种商品</Text>
        ) : null}
        <View className="shop-order__total">
          <Text className="shop-order__count">共 {order.totalQuantity} 件</Text>
          <Text className="shop-order__paid-label">
            {order.status === 'pending_payment' ? '应付' : '实付'}
          </Text>
          <Price value={paid} size="md" tone="text" />
        </View>
      </Pressable>
      {actions.length > 0 ? (
        <View className="shop-order__actions">
          {expiry && expired ? (
            <View className="shop-order__expiry">
              <Text className="shop-order__expiry-label">支付已超时</Text>
            </View>
          ) : expiry ? (
            <View className="shop-order__expiry">
              <Text className="shop-order__expiry-label">剩余</Text>
              <Countdown
                endsAt={expiry}
                onEnd={() => {
                  setEndedAt(expiry);
                  onExpire?.();
                }}
              />
            </View>
          ) : null}
          {actions.map((action) => (
            <Button
              key={action.key}
              size="sm"
              variant={action.variant}
              loading={busy === action.key}
              onClick={() => onAction(action.key, order)}
            >
              {action.label}
            </Button>
          ))}
        </View>
      ) : null}
    </View>
  );
}
