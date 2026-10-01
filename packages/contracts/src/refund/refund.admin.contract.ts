import { z } from 'zod';
import { defineRoute } from '../_conventions/route';
import {
  adminRefundDetail,
  adminRefundDetailExample,
  adminRefundExample,
  adminRefundListQuery,
  pagedAdminRefunds,
  refundApproveBody,
  refundIdParams,
  refundReceiveReturnBody,
  refundRejectBody,
  refundRemarkBody,
} from './schemas';

/**
 * Admin after-sales.
 *
 * The five write routes are the five decisions an operator actually makes:
 * agree, refuse, confirm the goods came back, leave a note, and — when the
 * gateway's answer was lost — ask again. There is no "set the refund amount"
 * route: the amount was frozen when the shopper applied, and re-pricing it
 * afterwards is the defect REFUND-005 describes.
 *
 * `approve` does *not* send money for a `return_and_refund`: it moves the
 * request to `approved` and waits for `receive-return`. For a `refund_only` it
 * goes straight on to the gateway, through the effects ledger, after commit.
 */

export const refundAdminList = defineRoute({
  id: 'refund.adminList',
  method: 'GET',
  path: '/admin-api/refunds',
  auth: 'admin',
  permission: 'refund:request:read',
  summary: '退款申请列表',
  tags: ['refund'],
  query: adminRefundListQuery,
  response: pagedAdminRefunds,
  examples: [
    {
      name: 'pending-review',
      query: { page: 1, pageSize: 20, status: 'applied' },
      response: { items: [adminRefundExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const refundAdminDetail = defineRoute({
  id: 'refund.adminDetail',
  method: 'GET',
  path: '/admin-api/refunds/:id',
  auth: 'admin',
  permission: 'refund:request:read',
  summary: '退款申请详情',
  tags: ['refund'],
  params: refundIdParams,
  response: adminRefundDetail,
  errors: ['REFUND_NOT_FOUND'],
  examples: [{ name: 'applied', params: { id: '601' }, response: adminRefundDetailExample }],
});

export const refundAdminApprove = defineRoute({
  id: 'refund.adminApprove',
  method: 'POST',
  path: '/admin-api/refunds/:id/approve',
  auth: 'admin',
  permission: 'refund:request:review',
  summary: '同意退款',
  tags: ['refund'],
  params: refundIdParams,
  body: refundApproveBody,
  response: adminRefundDetail,
  errors: [
    'REFUND_NOT_FOUND',
    'REFUND_NOT_ACTIONABLE',
    'REFUND_EXCEEDS_PAID',
    'REFUND_NO_ORIGINAL_PAYMENT',
    'REFUND_LINE_ALREADY_SHIPPED',
    'REFUND_RETURN_ADDRESS_MISSING',
  ],
  examples: [
    {
      name: 'await-return',
      params: { id: '601' },
      body: {
        remark: '同意，请寄回',
        returnAddress: {
          name: '售后仓',
          phone: '020-88888888',
          address: '广东省广州市天河区 xx 路 1 号',
        },
      },
      response: {
        ...adminRefundDetailExample,
        status: 'approved',
        returnStage: 'awaiting_shipment',
        adminRemark: '同意，请寄回',
        reviewedByAdminId: '1',
        reviewedAt: '2026-02-26T14:00:00+08:00',
        updatedAt: '2026-02-26T14:00:00+08:00',
      },
    },
  ],
});

export const refundAdminReject = defineRoute({
  id: 'refund.adminReject',
  method: 'POST',
  path: '/admin-api/refunds/:id/reject',
  auth: 'admin',
  permission: 'refund:request:review',
  summary: '拒绝退款',
  tags: ['refund'],
  params: refundIdParams,
  body: refundRejectBody,
  response: adminRefundDetail,
  errors: ['REFUND_NOT_FOUND', 'REFUND_NOT_ACTIONABLE'],
  examples: [
    {
      name: 'refused',
      params: { id: '601' },
      body: { rejectReason: '商品已签收超过 7 天' },
      response: {
        ...adminRefundDetailExample,
        status: 'rejected',
        rejectReason: '商品已签收超过 7 天',
        reviewedByAdminId: '1',
        reviewedAt: '2026-02-26T14:00:00+08:00',
        updatedAt: '2026-02-26T14:00:00+08:00',
      },
    },
  ],
});

export const refundAdminReceiveReturn = defineRoute({
  id: 'refund.adminReceiveReturn',
  method: 'POST',
  path: '/admin-api/refunds/:id/receive-return',
  auth: 'admin',
  permission: 'refund:request:execute',
  summary: '确认收到退货并退款',
  tags: ['refund'],
  params: refundIdParams,
  body: refundReceiveReturnBody,
  response: adminRefundDetail,
  errors: [
    'REFUND_NOT_FOUND',
    'REFUND_NOT_ACTIONABLE',
    'REFUND_RETURN_NOT_EXPECTED',
    'REFUND_EXCEEDS_PAID',
    'REFUND_NO_ORIGINAL_PAYMENT',
  ],
  examples: [
    {
      name: 'goods-back-money-out',
      params: { id: '601' },
      body: { remark: '已验收，外包装破损属实' },
      // `processing` is persisted before the gateway call; the succeeded state
      // arrives on the refund notification or on a later query.
      response: {
        ...adminRefundDetailExample,
        status: 'processing',
        returnStage: 'received',
        adminRemark: '已验收，外包装破损属实',
        updatedAt: '2026-02-26T15:00:00+08:00',
      },
    },
  ],
});

export const refundAdminRemark = defineRoute({
  id: 'refund.adminRemark',
  method: 'POST',
  path: '/admin-api/refunds/:id/remark',
  auth: 'admin',
  permission: 'refund:request:write',
  summary: '售后备注',
  tags: ['refund'],
  params: refundIdParams,
  body: refundRemarkBody,
  response: adminRefundDetail,
  errors: ['REFUND_NOT_FOUND'],
  examples: [
    {
      name: 'noted',
      params: { id: '601' },
      body: { adminRemark: '已电话联系买家' },
      response: { ...adminRefundDetailExample, adminRemark: '已电话联系买家' },
    },
  ],
});

export const refundAdminRetry = defineRoute({
  id: 'refund.adminRetry',
  method: 'POST',
  path: '/admin-api/refunds/:id/retry',
  auth: 'admin',
  permission: 'refund:request:execute',
  summary: '复核退款结果',
  tags: ['refund'],
  params: refundIdParams,
  body: z.object({}).default({}),
  response: adminRefundDetail,
  errors: [
    'REFUND_NOT_FOUND',
    'REFUND_NOT_ACTIONABLE',
    'REFUND_STATE_UNKNOWN',
    // 复核 of a refused 仅退款 whose units have shipped since (REFUND-015).
    'REFUND_LINE_ALREADY_SHIPPED',
  ],
  examples: [
    {
      name: 'resolved-to-succeeded',
      params: { id: '601' },
      body: {},
      // Queried by the frozen `outRefundNo`. A new number is never generated,
      // which is what makes this safe to press twice (REFUND-005/006).
      response: {
        ...adminRefundDetailExample,
        status: 'succeeded',
        returnStage: 'received',
        refundedAmount: '99.00',
        gatewayRefundId: '50000123452026022612345',
        succeededAt: '2026-02-26T15:02:00+08:00',
        updatedAt: '2026-02-26T15:02:00+08:00',
      },
    },
    {
      name: 'still-unknown',
      params: { id: '601' },
      body: {},
      response: {
        ...adminRefundDetailExample,
        status: 'unknown',
        returnStage: 'received',
        lastError: 'connect ETIMEDOUT api.mch.weixin.qq.com:443',
        lastErrorSummary: '没有收到微信支付的结果，系统会自动查询；也可以点「重试」立即查询',
      },
    },
  ],
});
