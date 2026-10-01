import { defineRoute } from '../_conventions/route';
import { orderRefParams } from './order.ref.schemas';
import {
  checkoutCreateBody,
  checkoutLineExample,
  checkoutPreview,
  checkoutPreviewBody,
  checkoutPreviewExample,
  orderCancelBody,
  orderCounts,
  orderCountsExample,
  orderDetail,
  orderDetailExample,
  orderHidden,
  orderListQuery,
  pagedOrders,
  storefrontOrderListItemExample,
} from './schemas';

/**
 * Checkout and the buyer's own orders.
 *
 * Six routes, and the shape of the first two is the whole design: `preview` and
 * `create` take the *same* input, and the server prices both from scratch.
 * There is no cached draft handed to the client between the two, so nothing can
 * disagree with the cart, the prices or the stock by the time the order is
 * created.
 *
 * Cancelling is `POST /api/v1/orders/:id/cancel`. Fulfilment (receipt,
 * delivery) and payment live on the same resource but are defined in
 * `order.fulfil.contract.ts` and the `payment` domain.
 */

export const checkoutPreviewRoute = defineRoute({
  id: 'order.checkoutPreview',
  method: 'POST',
  path: '/api/v1/checkout/preview',
  auth: 'user',
  summary: '确认订单（服务端重新计价）',
  tags: ['order'],
  body: checkoutPreviewBody,
  response: checkoutPreview,
  errors: [
    'ORDER_EMPTY',
    'ORDER_ITEM_UNAVAILABLE',
    'ORDER_VIRTUAL_CARD_QUANTITY',
    'ORDER_PURCHASE_LIMIT_REACHED',
    'ORDER_BELOW_MIN_PURCHASE',
    'ORDER_ADDRESS_NOT_FOUND',
    // The address is outside every region the freight template ships to.
    'SHIPPING_NOT_DELIVERABLE',
    'COUPON_NOT_USABLE',
    'COUPON_NOT_APPLICABLE',
    'COUPON_MIN_SPEND_NOT_MET',
  ],
  examples: [
    {
      name: 'cart-with-coupon',
      body: {
        source: 'cart',
        cartItemIds: [],
        addressId: '301',
        userCouponId: '9001',
        kind: 'normal',
      },
      response: checkoutPreviewExample,
    },
    {
      name: 'buy-now-no-address-yet',
      body: {
        source: 'buy-now',
        cartItemIds: [],
        item: { skuId: '21', quantity: 1 },
        addressId: null,
        userCouponId: null,
        kind: 'normal',
      },
      response: {
        ...checkoutPreviewExample,
        lines: [
          {
            ...checkoutLineExample,
            cartItemId: null,
            quantity: 1,
            subtotal: '60.00',
            discountAmount: '0.00',
            totalAmount: '60.00',
          },
        ],
        receiver: null,
        totalQuantity: 1,
        itemsAmount: '60.00',
        // No address yet, so freight cannot be worked out and is quoted as zero.
        freightAmount: '0.00',
        couponDiscount: '0.00',
        adjustments: [],
        payableAmount: '60.00',
        userCouponId: null,
      },
    },
    {
      name: 'groupbuy-join',
      // 参团: `kindMeta` is typed by `kind` (ORDER-009). Leave `groupId` out to 开团.
      body: {
        source: 'buy-now',
        item: { skuId: '21', quantity: 1 },
        addressId: '301',
        kind: 'groupbuy',
        kindMeta: { activityId: '12', groupId: '501' },
      },
      response: {
        ...checkoutPreviewExample,
        lines: [
          {
            ...checkoutLineExample,
            cartItemId: null,
            quantity: 1,
            subtotal: '60.00',
            discountAmount: '11.00',
            totalAmount: '49.00',
          },
        ],
        totalQuantity: 1,
        itemsAmount: '60.00',
        freightAmount: '0.00',
        couponDiscount: '11.00',
        adjustments: [
          { source: 'groupbuy:activity-price', label: '拼团价（两人团）', amount: '-11.00' },
        ],
        payableAmount: '49.00',
        userCouponId: null,
      },
    },
    {
      name: 'presale',
      body: {
        source: 'buy-now',
        item: { skuId: '21', quantity: 1 },
        addressId: '301',
        kind: 'presale',
        kindMeta: { activityId: '31' },
      },
      response: {
        ...checkoutPreviewExample,
        lines: [
          {
            ...checkoutLineExample,
            cartItemId: null,
            quantity: 1,
            subtotal: '60.00',
            discountAmount: '10.00',
            totalAmount: '50.00',
          },
        ],
        totalQuantity: 1,
        itemsAmount: '60.00',
        freightAmount: '0.00',
        couponDiscount: '10.00',
        adjustments: [
          { source: 'presale:activity-price', label: '预售价（秋季新品）', amount: '-10.00' },
        ],
        payableAmount: '50.00',
        shipAfterDays: 15,
        userCouponId: null,
      },
    },
  ],
});

export const orderCreate = defineRoute({
  id: 'order.create',
  method: 'POST',
  path: '/api/v1/orders',
  auth: 'user',
  summary: '提交订单',
  tags: ['order'],
  body: checkoutCreateBody,
  response: orderDetail,
  status: 201,
  errors: [
    'ORDER_EMPTY',
    'ORDER_ITEM_UNAVAILABLE',
    'ORDER_OUT_OF_STOCK',
    'ORDER_VIRTUAL_CARD_QUANTITY',
    'ORDER_PURCHASE_LIMIT_REACHED',
    'ORDER_BELOW_MIN_PURCHASE',
    'ORDER_ADDRESS_REQUIRED',
    'ORDER_ADDRESS_NOT_FOUND',
    'ORDER_CUSTOM_FORM_INCOMPLETE',
    'ORDER_PRICE_CHANGED',
    'SHIPPING_NOT_DELIVERABLE',
    'COUPON_NOT_USABLE',
    'COUPON_NOT_APPLICABLE',
    'COUPON_MIN_SPEND_NOT_MET',
    // 拼团 and 预售 check their activity, team and stock as the order is written.
    'GROUPBUY_ACTIVITY_NOT_FOUND',
    'GROUPBUY_ACTIVITY_NOT_OPEN',
    'GROUPBUY_QUANTITY_NOT_ALLOWED',
    'GROUPBUY_PRICE_NOT_APPLIED',
    'GROUPBUY_GROUP_NOT_FOUND',
    'GROUPBUY_GROUP_NOT_JOINABLE',
    'GROUPBUY_ALREADY_IN_GROUP',
    'GROUPBUY_OUT_OF_STOCK',
    'PRESALE_ACTIVITY_NOT_FOUND',
    'PRESALE_ACTIVITY_NOT_OPEN',
    'PRESALE_DEPOSIT_NOT_SUPPORTED',
    'PRESALE_QUANTITY_NOT_ALLOWED',
    'PRESALE_PRICE_NOT_APPLIED',
    'PRESALE_SKU_NOT_IN_ACTIVITY',
    'PRESALE_OUT_OF_STOCK',
  ],
  examples: [
    {
      name: 'ok',
      body: {
        source: 'cart',
        cartItemIds: ['5001'],
        addressId: '301',
        userCouponId: '9001',
        kind: 'normal',
        idempotencyKey: 'ck-20260201-7f3a9b21',
        buyerRemark: '请在工作日送达',
        expectedPayableAmount: '118.00',
      },
      response: orderDetailExample,
    },
    {
      name: 'replayed-submit',
      // The same key a second time: the first order comes back, not a new one.
      body: {
        source: 'cart',
        cartItemIds: ['5001'],
        addressId: '301',
        userCouponId: '9001',
        kind: 'normal',
        idempotencyKey: 'ck-20260201-7f3a9b21',
      },
      response: orderDetailExample,
    },
    {
      name: 'groupbuy-open',
      // 开团: no `groupId`. `kindMeta` is typed by `kind` (ORDER-009).
      body: {
        source: 'buy-now',
        item: { skuId: '21', quantity: 1 },
        addressId: '301',
        kind: 'groupbuy',
        kindMeta: { activityId: '12' },
        idempotencyKey: 'ck-20260201-gb000001',
        expectedPayableAmount: '49.00',
      },
      response: { ...orderDetailExample, kind: 'groupbuy', groupbuyTeamId: '501' },
    },
  ],
});

export const orderList = defineRoute({
  id: 'order.list',
  method: 'GET',
  path: '/api/v1/orders',
  auth: 'user',
  summary: '我的订单',
  tags: ['order'],
  query: orderListQuery,
  response: pagedOrders,
  examples: [
    {
      name: 'unpaid-tab',
      query: { page: 1, pageSize: 20, tab: 'unpaid' },
      response: { items: [storefrontOrderListItemExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'empty',
      query: { page: 1, pageSize: 20, tab: 'cancelled' },
      response: { items: [], total: 0, page: 1, pageSize: 20 },
    },
  ],
});

export const orderCountsRoute = defineRoute({
  id: 'order.counts',
  method: 'GET',
  path: '/api/v1/orders/counts',
  auth: 'user',
  summary: '订单角标数量',
  tags: ['order'],
  response: orderCounts,
  examples: [{ name: 'ok', response: orderCountsExample }],
});

export const orderGetDetail = defineRoute({
  id: 'order.detail',
  method: 'GET',
  path: '/api/v1/orders/:id',
  auth: 'user',
  summary: '订单详情',
  tags: ['order'],
  /**
   * `:id` is the surrogate id **or** the 24-digit `orderNo`. The order number
   * is the only identifier that appears outside the app — on the WeChat payment
   * record, in the 客服 conversation — so a deep link built from one has to
   * resolve. `orderRef` explains why the two can never collide.
   */
  params: orderRefParams,
  response: orderDetail,
  errors: ['ORDER_NOT_FOUND'],
  examples: [
    { name: 'by-id', params: { id: '9001' }, response: orderDetailExample },
    {
      name: 'by-order-no',
      params: { id: '202602011000000010123456' },
      response: orderDetailExample,
    },
  ],
});

/**
 * 取消订单.
 *
 * A POSTed sub-resource, not `DELETE /orders/:id`: cancelling is a state
 * transition with side effects (the coupon comes back, the stock comes back),
 * and the order row survives it.
 */
export const orderCancel = defineRoute({
  id: 'order.cancel',
  method: 'POST',
  path: '/api/v1/orders/:id/cancel',
  auth: 'user',
  summary: '取消订单',
  tags: ['order'],
  params: orderRefParams,
  body: orderCancelBody,
  response: orderDetail,
  errors: [
    'ORDER_NOT_FOUND',
    'ORDER_NOT_CANCELLABLE',
    'ORDER_ALREADY_PAID',
    'ORDER_PAYMENT_STATE_UNKNOWN',
    'ORDER_COUPON_RELEASE_FAILED',
  ],
  examples: [
    {
      name: 'ok',
      params: { id: '9001' },
      body: { reason: '不想要了' },
      response: {
        ...orderDetailExample,
        status: 'cancelled',
        payExpiresAt: null,
        cancelledAt: '2026-02-01T10:05:00+08:00',
        cancelReason: '不想要了',
      },
    },
  ],
});

/**
 * 删除订单 — which deletes nothing.
 *
 * The buyer's own list stops showing a finished order, and the shop keeps every
 * row of it. That asymmetry is the whole point — the money, the invoice and the
 * after-sales window all outlive the button — so the verb is `DELETE` only
 * because that is what the tap means to the person pressing it, and
 * `hidden_by_user_at` is what it writes.
 *
 * Only `completed`, `cancelled` and `refunded` may be hidden: anything else is
 * still in flight and the buyer would be hiding an order they may need to act
 * on. Hiding twice answers `ORDER_NOT_FOUND`, because after the first one the
 * order is no longer in the caller's list to refer to.
 */
export const orderHide = defineRoute({
  id: 'order.hide',
  method: 'DELETE',
  path: '/api/v1/orders/:id',
  auth: 'user',
  summary: '删除订单（仅从我的订单隐藏）',
  tags: ['order'],
  params: orderRefParams,
  response: orderHidden,
  errors: ['ORDER_NOT_FOUND', 'ORDER_NOT_DELETABLE'],
  examples: [{ name: 'ok', params: { id: '9001' }, response: { hidden: true } }],
});
