import { z } from 'zod';
import { defineRoute } from '../_conventions/route';
import {
  myRefundListQuery,
  pagedMyRefunds,
  refundApplyBody,
  refundDetail,
  refundDetailExample,
  refundExample,
  refundIdParams,
  refundReasonList,
  refundReturnShipmentBody,
  refundableItemsExample,
  refundableItemsParams,
  refundableItemsResult,
} from './schemas';

/**
 * Storefront after-sales, `/api/v1/refunds` and `/api/v1/refund-reasons`.
 *
 * After-sales is its own resource with its own id, not a sub-route of the
 * order, which is what lets a shopper have two open requests on two lines of
 * one order.
 */

export const refundReasons = defineRoute({
  id: 'refund.reasons',
  method: 'GET',
  path: '/api/v1/refund-reasons',
  auth: 'public',
  summary: '退款原因列表',
  tags: ['refund'],
  response: refundReasonList,
  examples: [
    {
      name: 'default',
      response: {
        items: ['不想要了', '商品破损', '与描述不符', '少件/漏发', '质量问题', '其他'],
      },
    },
  ],
});

export const refundApplicableItems = defineRoute({
  id: 'refund.applicableItems',
  method: 'GET',
  path: '/api/v1/refunds/applicable-items/:orderId',
  auth: 'user',
  summary: '可申请售后的商品',
  tags: ['refund'],
  params: refundableItemsParams,
  response: refundableItemsResult,
  errors: ['REFUND_ORDER_NOT_FOUND', 'REFUND_ORDER_NOT_REFUNDABLE'],
  examples: [
    { name: 'one-line', params: { orderId: '3001' }, response: refundableItemsExample },
    {
      name: 'line-already-in-after-sales',
      params: { orderId: '3001' },
      response: {
        ...refundableItemsExample,
        refundableAmount: '99.00',
        items: [
          {
            ...refundableItemsExample.items[0]!,
            refundableQuantity: 0,
            refundableAmount: '0.00',
            blockedReason: 'REFUND_ALREADY_OPEN',
          },
        ],
      },
    },
  ],
});

export const refundApply = defineRoute({
  id: 'refund.apply',
  method: 'POST',
  path: '/api/v1/refunds',
  auth: 'user',
  summary: '申请退款/退货',
  tags: ['refund'],
  body: refundApplyBody,
  response: refundDetail,
  status: 201,
  errors: [
    'REFUND_ORDER_NOT_FOUND',
    'REFUND_ORDER_NOT_REFUNDABLE',
    'REFUND_LINE_INVALID',
    'REFUND_ALREADY_OPEN',
    'REFUND_EXCEEDS_PAID',
    'REFUND_AMOUNT_ZERO',
    'REFUND_FREIGHT_NOT_REFUNDABLE',
    'REFUND_NO_ORIGINAL_PAYMENT',
    'REFUND_IMAGE_NOT_ALLOWED',
  ],
  examples: [
    {
      name: 'return-and-refund',
      body: {
        orderId: '3001',
        kind: 'return_and_refund',
        lines: [{ orderItemId: '7001', quantity: 1 }],
        reason: '商品破损',
        explanation: '收到时箱子被压坏，里面有三个苹果烂了',
        images: ['https://cdn.example/u/77/refund-601-1.jpg'],
        includeFreight: false,
      },
      response: refundDetailExample,
    },
    {
      name: 'refund-only-before-shipment',
      body: {
        orderId: '3001',
        kind: 'refund_only',
        lines: [{ orderItemId: '7001', quantity: 1 }],
        reason: '不想要了',
        images: [],
        includeFreight: true,
      },
      response: {
        ...refundDetailExample,
        id: '602',
        refundNo: 'RF2602261301000602',
        kind: 'refund_only',
        returnStage: 'not_required',
        includesFreight: true,
        reason: '不想要了',
        explanation: null,
        images: [],
      },
    },
  ],
});

export const refundMyList = defineRoute({
  id: 'refund.myList',
  method: 'GET',
  path: '/api/v1/refunds',
  auth: 'user',
  summary: '我的售后单',
  tags: ['refund'],
  query: myRefundListQuery,
  response: pagedMyRefunds,
  examples: [
    {
      name: 'all',
      query: { page: 1, pageSize: 20, state: 'all' },
      response: { items: [refundExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const refundMyDetail = defineRoute({
  id: 'refund.myDetail',
  method: 'GET',
  path: '/api/v1/refunds/:id',
  auth: 'user',
  summary: '售后单详情',
  tags: ['refund'],
  params: refundIdParams,
  response: refundDetail,
  errors: ['REFUND_NOT_FOUND'],
  examples: [{ name: 'applied', params: { id: '601' }, response: refundDetailExample }],
});

export const refundCancel = defineRoute({
  id: 'refund.cancel',
  method: 'POST',
  path: '/api/v1/refunds/:id/cancel',
  auth: 'user',
  summary: '撤销售后申请',
  tags: ['refund'],
  params: refundIdParams,
  body: z.object({}).default({}),
  response: refundDetail,
  errors: ['REFUND_NOT_FOUND', 'REFUND_NOT_ACTIONABLE'],
  examples: [
    {
      name: 'withdrawn',
      params: { id: '601' },
      body: {},
      // `is_open` clears in the same statement, so the line is immediately
      // available for a new request.
      response: {
        ...refundDetailExample,
        status: 'cancelled',
        logs: [
          ...refundDetailExample.logs,
          {
            toStatus: 'cancelled',
            message: '买家撤销申请',
            createdAt: '2026-02-26T13:10:00+08:00',
          },
        ],
      },
    },
  ],
});

export const refundSubmitReturnShipment = defineRoute({
  id: 'refund.submitReturnShipment',
  method: 'POST',
  path: '/api/v1/refunds/:id/return-shipment',
  auth: 'user',
  summary: '填写退货物流',
  tags: ['refund'],
  params: refundIdParams,
  body: refundReturnShipmentBody,
  response: refundDetail,
  errors: ['REFUND_NOT_FOUND', 'REFUND_NOT_ACTIONABLE', 'REFUND_RETURN_NOT_EXPECTED'],
  examples: [
    {
      name: 'shipped-back',
      params: { id: '601' },
      body: { expressCompanyId: '4', trackingNo: 'SF1234567890123', phone: '13800000000' },
      response: {
        ...refundDetailExample,
        status: 'approved',
        returnStage: 'shipped_back',
        returnExpressCompanyId: '4',
        returnExpressCompanyName: '顺丰速运',
        returnTrackingNo: 'SF1234567890123',
        returnPhone: '13800000000',
        returnAddress: {
          name: '售后仓',
          phone: '020-88888888',
          address: '广东省广州市天河区 xx 路 1 号',
        },
      },
    },
  ],
});

export const refundHide = defineRoute({
  id: 'refund.hide',
  method: 'DELETE',
  path: '/api/v1/refunds/:id',
  auth: 'user',
  summary: '从我的列表中删除售后单',
  tags: ['refund'],
  params: refundIdParams,
  response: z.object({ deleted: z.boolean() }),
  errors: ['REFUND_NOT_FOUND', 'REFUND_NOT_ACTIONABLE'],
  examples: [{ name: 'hidden', params: { id: '601' }, response: { deleted: true } }],
});
