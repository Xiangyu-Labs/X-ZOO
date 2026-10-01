import type { StorefrontOrderListItem } from '@shop/contracts/order/schemas';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { taroFake } from '@/test/taro-fake/taro';
import { orderActions, orderStatusText } from './order-actions';
import { OrderCard } from './order-card';

const item = (id: string) => ({
  id,
  itemKey: `sku-${id}`,
  productId: '11',
  skuId: '21',
  productName: `商品 ${id}`,
  productImageUrl: '/p.jpg',
  productKind: 'physical' as const,
  specText: '混合装|1000g',
  skuImageUrl: null,
  unitName: '盒',
  quantity: 1,
  unitPrice: '60.00',
  originalUnitPrice: null,
  discountAmount: '0.00',
  totalAmount: '60.00',
  refundedQuantity: 0,
  shippedQuantity: 0,
  adjustments: [],
  reviewed: false,
  reviewable: false,
});

const order: StorefrontOrderListItem = {
  id: '9001',
  orderNo: '202602011000000010123456',
  kind: 'normal',
  status: 'shipped',
  fulfillmentStatus: 'fulfilled',
  refundStatus: 'none',
  totalQuantity: 4,
  itemsAmount: '240.00',
  freightAmount: '0.00',
  couponDiscount: '0.00',
  payableAmount: '240.00',
  paidAmount: '240.00',
  payExpiresAt: null,
  createdAt: '2026-02-01T10:00:00+08:00',
  refundedAmount: '0.00',
  hasOpenRefund: false,
  groupbuyTeam: null,
  items: [item('1'), item('2'), item('3'), item('4')],
};

const keys = (o: Partial<StorefrontOrderListItem>) =>
  orderActions({ ...order, ...o }).map((action) => action.key);
/** Lines as the shopper's own reads carry them, one still to review. */
const toReview = [
  { ...item('1'), reviewed: true },
  { ...item('2'), reviewable: true },
];
const reviewed = [{ ...item('1'), reviewed: true }];

describe('orderActions', () => {
  it('gives each status its buttons, the primary one last', () => {
    expect(keys({ status: 'pending_payment' })).toEqual(['cancel', 'pay']);
    expect(keys({ status: 'paid', fulfillmentStatus: 'unfulfilled' })).toEqual(['aftersale']);
    expect(keys({ status: 'paid', fulfillmentStatus: 'partially_fulfilled' })).toEqual([
      'aftersale',
      'logistics',
    ]);
    expect(keys({ status: 'shipped' })).toEqual(['aftersale', 'logistics', 'confirm']);
    expect(keys({ status: 'received', items: toReview })).toEqual(['aftersale', 'rebuy', 'review']);
    expect(keys({ status: 'completed' })).toEqual(['delete', 'rebuy']);
    expect(keys({ status: 'cancelled' })).toEqual(['delete', 'rebuy']);
    expect(keys({ status: 'cancelled', kind: 'groupbuy' })).toEqual(['delete']);
    expect(orderActions({ ...order, status: 'pending_payment' }).at(-1)?.variant).toBe('primary');
  });

  it('offers 去评价 only while some line can be reviewed', () => {
    expect(keys({ status: 'received', items: reviewed })).toEqual(['aftersale', 'rebuy']);
    expect(keys({ status: 'completed', items: toReview })).toEqual(['delete', 'rebuy', 'review']);
  });

  it('holds 申请售后 back while one is open', () => {
    expect(keys({ status: 'shipped', refundStatus: 'requested' })).toEqual([
      'logistics',
      'confirm',
    ]);
  });

  it('names the status the way the tabs do', () => {
    expect(
      orderStatusText({ ...order, status: 'paid', fulfillmentStatus: 'partially_fulfilled' }),
    ).toBe('部分发货');
    expect(orderStatusText({ ...order, status: 'received', items: toReview })).toBe('待评价');
    expect(orderStatusText({ ...order, status: 'completed', items: toReview })).toBe('待评价');
    expect(orderStatusText({ ...order, status: 'received', items: reviewed })).toBe('已完成');
  });

  it('says 拼团中, not 待发货, while a 拼团 order waits for its team, and 未成团 once it failed', () => {
    const paid = { ...order, kind: 'groupbuy' as const, status: 'paid' as const };
    const team = (status: 'forming' | 'succeeded' | 'failed' | 'cancelled') => ({
      id: '5',
      status,
      role: 'member' as const,
      seatsTotal: 3,
      seatsTaken: 2,
      expiresAt: '2099-01-01T00:00:00+08:00',
    });
    expect(orderStatusText({ ...paid, groupbuyTeam: team('forming') })).toBe('拼团中');
    expect(orderStatusText({ ...paid, groupbuyTeam: team('failed') })).toBe('未成团');
    expect(orderStatusText({ ...paid, groupbuyTeam: team('cancelled') })).toBe('未成团');
    expect(orderStatusText({ ...paid, groupbuyTeam: team('succeeded') })).toBe('待发货');
  });
});

describe('OrderCard', () => {
  it('shows three lines, the rest counted, the amount paid and the actions', () => {
    const onAction = vi.fn();
    render(<OrderCard order={order} onAction={onAction} />);
    expect(screen.getByText('待收货')).toBeTruthy();
    expect(screen.getByText('商品 3')).toBeTruthy();
    expect(screen.getAllByText('混合装 / 1000g')).toHaveLength(3);
    expect(screen.queryByText('商品 4')).toBeNull();
    expect(screen.getByText('还有 1 种商品')).toBeTruthy();
    expect(screen.getByText('共 4 件')).toBeTruthy();
    expect(screen.getByText('实付')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认收货' }));
    expect(onAction).toHaveBeenCalledWith('confirm', order);
  });

  it('opens the order', async () => {
    render(<OrderCard order={order} onAction={() => undefined} />);
    fireEvent.click(screen.getByRole('link', { name: `订单 ${order.orderNo}，待收货` }));
    await vi.waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: '/packages/order/detail/index?id=9001' },
      }),
    );
  });

  it('counts an unpaid order down and spins the action in flight', () => {
    render(
      <OrderCard
        order={{
          ...order,
          status: 'pending_payment',
          paidAmount: null,
          payExpiresAt: '2999-01-01T00:00:00+08:00',
        }}
        onAction={() => undefined}
        busy="pay"
      />,
    );
    expect(screen.getByText('应付')).toBeTruthy();
    expect(screen.getByRole('timer')).toBeTruthy();
    expect(screen.getByRole('button', { name: '立即付款' }).className).toContain(
      'shop-btn--loading',
    );
  });

  it('says 支付已超时 and offers no 立即付款 once the time to pay is gone', () => {
    render(
      <OrderCard
        order={{
          ...order,
          status: 'pending_payment',
          paidAmount: null,
          payExpiresAt: '2020-01-01T00:00:00+08:00',
        }}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByText('支付已超时')).toBeTruthy();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(screen.queryByRole('button', { name: '立即付款' })).toBeNull();
    expect(screen.getByRole('button', { name: '取消订单' })).toBeTruthy();
  });

  it('reads the list again when the countdown runs out on screen', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-25T10:00:00+08:00') });
    try {
      const onExpire = vi.fn();
      render(
        <OrderCard
          order={{
            ...order,
            status: 'pending_payment',
            paidAmount: null,
            payExpiresAt: '2026-09-25T10:00:02+08:00',
          }}
          onAction={() => undefined}
          onExpire={onExpire}
        />,
      );
      expect(screen.getByRole('button', { name: '立即付款' })).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(onExpire).toHaveBeenCalledTimes(1);
      expect(screen.getByText('支付已超时')).toBeTruthy();
      expect(screen.queryByRole('button', { name: '立即付款' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('prints an activity line at the price paid, not the catalogue price', () => {
    const { container } = render(
      <OrderCard
        order={{
          ...order,
          kind: 'presale',
          totalQuantity: 1,
          itemsAmount: '88.00',
          couponDiscount: '15.00',
          payableAmount: '73.00',
          paidAmount: '73.00',
          items: [
            {
              ...item('1'),
              unitPrice: '88.00',
              adjustments: [
                { source: 'presale:activity-price', label: '预售价', amount: '-10.00' },
                { source: 'coupon:discount', label: '券', amount: '-5.00' },
              ],
            },
          ],
        }}
        onAction={() => undefined}
      />,
    );
    expect(container.textContent).toContain('¥78.00×1');
    expect(container.textContent).toContain('实付¥73.00');
    expect(container.textContent).not.toContain('88.00');
  });

  it('tags a group-buy order and says 售后中 while a refund is open', () => {
    render(
      <OrderCard
        order={{ ...order, kind: 'groupbuy', refundStatus: 'requested', hasOpenRefund: true }}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByText('拼团')).toBeTruthy();
    expect(screen.getByText('售后中')).toBeTruthy();
  });

  it('says 售后中 for a second request after a partial refund, and not once none is open', () => {
    const { rerender } = render(
      <OrderCard
        order={{ ...order, refundStatus: 'partially_refunded', hasOpenRefund: true }}
        onAction={() => undefined}
      />,
    );
    expect(screen.getByText('售后中')).toBeTruthy();
    rerender(
      <OrderCard
        order={{ ...order, refundStatus: 'partially_refunded', hasOpenRefund: false }}
        onAction={() => undefined}
      />,
    );
    expect(screen.queryByText('售后中')).toBeNull();
  });

  it('offers no 删除订单 while a request is open (ORDER-014)', () => {
    expect(keys({ status: 'completed', hasOpenRefund: true })).not.toContain('delete');
    expect(keys({ status: 'completed', hasOpenRefund: false })).toContain('delete');
  });
});
