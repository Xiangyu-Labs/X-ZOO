import { orderRefParams } from '../order/order.ref.schemas';
import { defineRoute } from '../_conventions/route';
import {
  paymentIntent,
  paymentIntentExample,
  paymentOutTradeNoParams,
  paymentStatusResult,
  startPaymentBody,
} from './schemas';

/**
 * Storefront payment routes.
 *
 * Two of them, and that is the whole shopper-facing surface: start a payment,
 * and ask whether the money landed. The cashier reads the order from the order
 * domain's own route and asks this domain only about money.
 */

export const paymentStart = defineRoute({
  id: 'payment.start',
  method: 'POST',
  path: '/api/v1/orders/:id/payments',
  auth: 'user',
  summary: '发起支付',
  tags: ['payment'],
  params: orderRefParams,
  body: startPaymentBody,
  response: paymentIntent,
  status: 201,
  errors: [
    'PAYMENT_ORDER_NOT_FOUND',
    'PAYMENT_ORDER_NOT_PAYABLE',
    'PAYMENT_ORDER_ALREADY_PAID',
    'PAYMENT_ORDER_EXPIRED',
    'PAYMENT_ATTEMPT_CONFLICT',
    'PAYMENT_OPENID_REQUIRED',
    'PAYMENT_CHANNEL_UNAVAILABLE',
    'PAYMENT_RETURN_URL_INVALID',
    'PAYMENT_NOT_CONFIGURED',
    'PAYMENT_GATEWAY_REFUSED',
    'PAYMENT_STATE_UNKNOWN',
  ],
  examples: [
    {
      name: 'mini-program',
      params: { id: '3001' },
      body: { channel: 'wechat_mini' },
      response: paymentIntentExample,
    },
    {
      name: 'official-account',
      params: { id: '3001' },
      body: { channel: 'wechat_oa', openid: 'oFakeOpenid0000000000000001' },
      response: { ...paymentIntentExample, channel: 'wechat_oa' },
    },
    {
      name: 'h5',
      params: { id: '3001' },
      body: { channel: 'wechat_h5', returnUrl: 'https://shop.example/pages/order/3001' },
      response: {
        ...paymentIntentExample,
        channel: 'wechat_h5',
        jsapi: null,
        h5Url: 'https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=wx26123456789012',
      },
    },
    {
      name: 'replayed-tap',
      params: { id: '3001' },
      body: { channel: 'wechat_mini' },
      // PAYC-003: a second tap replays the open attempt, same merchant order
      // number, rather than creating a second one.
      response: paymentIntentExample,
    },
  ],
});

export const paymentStatus = defineRoute({
  id: 'payment.status',
  method: 'GET',
  path: '/api/v1/payments/:outTradeNo',
  auth: 'user',
  summary: '查询支付结果',
  tags: ['payment'],
  params: paymentOutTradeNoParams,
  response: paymentStatusResult,
  errors: ['PAYMENT_ATTEMPT_NOT_FOUND'],
  examples: [
    {
      name: 'paid',
      params: { outTradeNo: 'P2602261200003001A7F3' },
      response: {
        outTradeNo: 'P2602261200003001A7F3',
        orderId: '3001',
        status: 'paid',
        paid: true,
        paidAt: '2026-02-26T12:02:31+08:00',
      },
    },
    {
      name: 'still-waiting',
      params: { outTradeNo: 'P2602261200003001A7F3' },
      response: {
        outTradeNo: 'P2602261200003001A7F3',
        orderId: '3001',
        status: 'submitted',
        paid: false,
        paidAt: null,
      },
    },
  ],
});
