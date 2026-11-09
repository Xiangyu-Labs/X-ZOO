import { describe, expect, it } from 'vitest';
import { adminOrderListItemExample } from '@shop/contracts/order/order.fulfil.schemas';

import { hasShippableLine, orderActionOf, shippableOrder, teamForming } from './order-actions';

const paid = adminOrderListItemExample;
const shipped = {
  ...paid,
  status: 'shipped' as const,
  fulfillmentStatus: 'fulfilled' as const,
  shippedAt: '2026-02-02T09:00:00+08:00',
};

describe('order actions', () => {
  it('offers 发货 on a paid order with something left to send', () => {
    expect(orderActionOf(paid)).toBe('ship');
    expect(
      orderActionOf({ ...paid, fulfillmentStatus: 'partially_fulfilled', shippedAt: null }),
    ).toBe('ship');
    expect(shippableOrder(paid)).toBe(true);
  });

  it('does not offer 发货 on a 拼团 that has not succeeded', () => {
    const forming = { ...paid, kind: 'groupbuy' as const, groupbuyTeamStatus: 'forming' as const };
    expect(teamForming(forming)).toBe(true);
    expect(shippableOrder(forming)).toBe(false);
    expect(orderActionOf(forming)).toBe('none');
    expect(teamForming({ ...forming, groupbuyTeamStatus: 'succeeded' })).toBe(false);
  });

  it('offers 物流详情 after dispatch, but not once the order is over', () => {
    expect(orderActionOf(shipped)).toBe('logistics');
    expect(orderActionOf({ ...shipped, status: 'received' })).toBe('logistics');
    expect(orderActionOf({ ...shipped, status: 'completed' })).toBe('none');
    expect(orderActionOf({ ...shipped, status: 'refunded', refundStatus: 'refunded' })).toBe(
      'none',
    );
    expect(orderActionOf({ ...shipped, status: 'cancelled' })).toBe('none');
  });

  it('puts an open after-sales first, whatever the fulfilment is', () => {
    expect(orderActionOf({ ...paid, refundStatus: 'requested' })).toBe('aftersale');
    expect(orderActionOf({ ...shipped, refundStatus: 'requested' })).toBe('aftersale');
  });

  it('offers nothing on 待付款', () => {
    expect(orderActionOf({ ...paid, status: 'pending_payment' })).toBe('none');
  });

  it('counts only lines an operator ships by hand', () => {
    const item = paid.items[0]!;
    expect(hasShippableLine({ items: [{ ...item, productKind: 'physical' }] })).toBe(true);
    expect(hasShippableLine({ items: [{ ...item, productKind: 'virtual_manual' }] })).toBe(true);
    expect(hasShippableLine({ items: [{ ...item, productKind: 'virtual_card' }] })).toBe(false);
    expect(hasShippableLine({ items: [{ ...item, shippedQuantity: item.quantity }] })).toBe(false);
    expect(hasShippableLine({ items: [{ ...item, refundedQuantity: item.quantity }] })).toBe(false);
  });
});
