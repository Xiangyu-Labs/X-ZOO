import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import { orderGiftCoupons, userCouponExample } from './schemas';

/**
 * 订单赠券: the panel on the shopper's own order page.
 *
 * The coupons an order earned are not inside the order detail: the order
 * detail stays a single shape owned by the order domain and the coupons are
 * their own call, so a wallet write never has to widen an order response.
 */

/**
 * `:id` is the surrogate id **or** the order number, the same as every other
 * storefront order route, and a stranger gets the same `404` as an unknown
 * reference. Answering `403` here would confirm the order exists.
 */
export const orderGiftCouponList = defineRoute({
  id: 'coupon.orderGiftCoupons',
  method: 'GET',
  path: '/api/v1/orders/:id/gift-coupons',
  auth: 'user',
  summary: '订单赠送的优惠券',
  tags: ['coupon'],
  params: z.object({ id }),
  response: orderGiftCoupons,
  errors: ['ORDER_NOT_FOUND'],
  examples: [
    {
      name: 'two-gift-coupons',
      params: { id: '5001' },
      response: {
        items: [
          { ...userCouponExample, id: '9001', sourceKind: 'gift_order' },
          {
            ...userCouponExample,
            id: '9002',
            templateId: '2',
            title: '满 200 减 30',
            discountAmount: '30.00',
            minSpend: '200.00',
            sourceKind: 'gift_order',
          },
        ],
      },
    },
    {
      // Not an error: most orders earn nothing, and the page still asks.
      name: 'none',
      params: { id: '5002' },
      response: { items: [] },
    },
  ],
});
