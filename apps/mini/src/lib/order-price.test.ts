import { describe, expect, it } from 'vitest';
import { orderDetail, orderItem, orderListItem } from '@/test/order-fixtures';
import { activityDiscountCents, linePaidUnitPrice, orderPrices } from './order-price';

const presaleLine = orderItem('7001', {
  unitPrice: '88.00',
  discountAmount: '15.00',
  totalAmount: '73.00',
  adjustments: [
    { source: 'presale:activity-price', label: '预售价', amount: '-10.00' },
    { source: 'coupon:discount', label: 'E2E 预售叠加券', amount: '-5.00' },
  ],
});

describe('order prices', () => {
  it('takes only the activity entries as the activity discount', () => {
    expect(activityDiscountCents(presaleLine.adjustments)).toBe(1000);
    expect(
      activityDiscountCents([{ source: 'coupon:discount', label: '券', amount: '-5.00' }]),
    ).toBe(0);
  });

  it('prints a presale line at its activity price and the coupon alone as 优惠券', () => {
    const order = orderListItem({
      kind: 'presale',
      itemsAmount: '88.00',
      couponDiscount: '15.00',
      payableAmount: '73.00',
      items: [presaleLine],
    });
    expect(orderPrices(order)).toEqual({
      itemsAmount: '78.00',
      couponDiscount: '5.00',
      unitPrices: { '7001': '78.00' },
    });
  });

  it('spreads a 拼团 discount over the quantity', () => {
    const line = orderItem('7002', {
      unitPrice: '50.00',
      quantity: 3,
      adjustments: [{ source: 'groupbuy:activity-price', label: '拼团价', amount: '-30.00' }],
    });
    expect(linePaidUnitPrice(line)).toBe('40.00');
  });

  it('leaves a normal order with a coupon as the payload says', () => {
    const order = orderListItem({
      itemsAmount: '120.00',
      couponDiscount: '10.00',
      items: [
        orderItem('7001', {
          unitPrice: '60.00',
          quantity: 2,
          adjustments: [
            { source: 'coupon:full-reduction', label: '满 100 减 10', amount: '-10.00' },
          ],
        }),
      ],
    });
    expect(orderPrices(order)).toEqual({
      itemsAmount: '120.00',
      couponDiscount: '10.00',
      unitPrices: { '7001': '60.00' },
    });
  });

  it('reads an older single-line activity order without a coupon from its couponDiscount', () => {
    const order = orderDetail({
      kind: 'presale',
      itemsAmount: '88.00',
      couponDiscount: '10.00',
      userCouponId: null,
      items: [orderItem('7001', { unitPrice: '88.00' })],
    });
    expect(orderPrices(order)).toMatchObject({
      itemsAmount: '78.00',
      couponDiscount: '0.00',
      unitPrices: { '7001': '78.00' },
    });
    // A list row has no userCouponId: the coupon cannot be ruled out, the payload stands.
    const { userCouponId: _, ...row } = order;
    expect(orderPrices(row).itemsAmount).toBe('88.00');
  });
});
