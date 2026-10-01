import { z } from 'zod';
import { defineRoute } from '../_conventions/route';
import {
  capitalFlowExample,
  capitalFlowListQuery,
  capitalFlowSummaryQuery,
  capitalFlowSummary,
  pagedCapitalFlows,
  pagedPaymentAttempts,
  pagedPaymentEffects,
  pagedPaymentExceptions,
  paymentAttemptExample,
  paymentAttemptListQuery,
  paymentEffectExample,
  paymentEffectListQuery,
  paymentEffectRetryResult,
  paymentExceptionDetail,
  paymentExceptionDetailExample,
  paymentExceptionExample,
  paymentExceptionIgnoreBody,
  paymentExceptionListQuery,
  paymentExceptionRefundBody,
  paymentIdParams,
} from './schemas';

/**
 * The operator's money console: what was attempted, what could not be booked,
 * what moved, and what still needs a human.
 *
 * Everything here is read-or-repair. There is no "mark as paid" button and
 * there never will be: an order becomes paid because the gateway said so, or it
 * does not become paid.
 */

export const paymentAdminAttemptList = defineRoute({
  id: 'payment.adminAttemptList',
  method: 'GET',
  path: '/admin-api/payment-attempts',
  auth: 'admin',
  permission: 'payment:attempt:read',
  summary: '支付记录',
  tags: ['payment'],
  query: paymentAttemptListQuery,
  response: pagedPaymentAttempts,
  examples: [
    {
      name: 'default',
      query: { page: 1, pageSize: 20 },
      response: { items: [paymentAttemptExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const paymentAdminExceptionList = defineRoute({
  id: 'payment.adminExceptionList',
  method: 'GET',
  path: '/admin-api/payment-exceptions',
  auth: 'admin',
  permission: 'payment:exception:read',
  summary: '异常支付',
  tags: ['payment'],
  query: paymentExceptionListQuery,
  response: pagedPaymentExceptions,
  examples: [
    {
      name: 'open',
      query: { page: 1, pageSize: 20, status: 'open' },
      response: { items: [paymentExceptionExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const paymentAdminExceptionDetail = defineRoute({
  id: 'payment.adminExceptionDetail',
  method: 'GET',
  path: '/admin-api/payment-exceptions/:id',
  auth: 'admin',
  permission: 'payment:exception:read',
  summary: '异常支付详情',
  tags: ['payment'],
  params: paymentIdParams,
  response: paymentExceptionDetail,
  errors: ['PAYMENT_EXCEPTION_NOT_FOUND'],
  examples: [{ name: 'open', params: { id: '11' }, response: paymentExceptionDetailExample }],
});

export const paymentAdminExceptionRefund = defineRoute({
  id: 'payment.adminExceptionRefund',
  method: 'POST',
  path: '/admin-api/payment-exceptions/:id/refund',
  auth: 'admin',
  permission: 'payment:exception:handle',
  summary: '原路退回异常支付',
  tags: ['payment'],
  params: paymentIdParams,
  body: paymentExceptionRefundBody,
  response: paymentExceptionDetail,
  errors: [
    'PAYMENT_EXCEPTION_NOT_FOUND',
    'PAYMENT_EXCEPTION_NOT_ACTIONABLE',
    'PAYMENT_EXCEPTION_NOT_REFUNDABLE',
    'PAYMENT_NOT_CONFIGURED',
    'PAYMENT_GATEWAY_REFUSED',
    'PAYMENT_STATE_UNKNOWN',
  ],
  examples: [
    {
      name: 'submitted',
      params: { id: '11' },
      body: { note: '客户已确认重复付款' },
      // `refunding` is persisted *before* the gateway is called, so a timeout
      // can never roll back "we may already have refunded".
      response: {
        ...paymentExceptionDetailExample,
        status: 'refunding',
        refundNo: 'XR2602261230000011',
        note: '客户已确认重复付款',
        operatorAdminId: '1',
      },
    },
  ],
});

export const paymentAdminExceptionIgnore = defineRoute({
  id: 'payment.adminExceptionIgnore',
  method: 'POST',
  path: '/admin-api/payment-exceptions/:id/ignore',
  auth: 'admin',
  permission: 'payment:exception:handle',
  summary: '标记异常支付为已处理',
  tags: ['payment'],
  params: paymentIdParams,
  body: paymentExceptionIgnoreBody,
  response: paymentExceptionDetail,
  errors: ['PAYMENT_EXCEPTION_NOT_FOUND', 'PAYMENT_EXCEPTION_NOT_ACTIONABLE'],
  examples: [
    {
      name: 'handled-offline',
      params: { id: '11' },
      body: { note: '已线下转账退回，凭证号 20260226-77' },
      response: {
        ...paymentExceptionDetailExample,
        status: 'ignored',
        note: '已线下转账退回，凭证号 20260226-77',
        operatorAdminId: '1',
        resolvedAt: '2026-02-26T14:00:00+08:00',
      },
    },
  ],
});

export const paymentAdminExceptionRecheck = defineRoute({
  id: 'payment.adminExceptionRecheck',
  method: 'POST',
  path: '/admin-api/payment-exceptions/:id/recheck',
  auth: 'admin',
  permission: 'payment:exception:handle',
  summary: '向网关复核异常支付的退款结果',
  tags: ['payment'],
  params: paymentIdParams,
  body: z.object({}).default({}),
  response: paymentExceptionDetail,
  errors: [
    'PAYMENT_EXCEPTION_NOT_FOUND',
    'PAYMENT_EXCEPTION_NOT_ACTIONABLE',
    'PAYMENT_NOT_CONFIGURED',
    'PAYMENT_STATE_UNKNOWN',
  ],
  examples: [
    {
      name: 'resolved',
      params: { id: '11' },
      body: {},
      // Queried by the frozen `refundNo`, never re-sent with a new one.
      response: {
        ...paymentExceptionDetailExample,
        status: 'refunded',
        refundNo: 'XR2602261230000011',
        refundedAt: '2026-02-26T12:35:00+08:00',
        resolvedAt: '2026-02-26T12:35:00+08:00',
      },
    },
  ],
});

export const paymentAdminCapitalFlowList = defineRoute({
  id: 'payment.adminCapitalFlowList',
  method: 'GET',
  path: '/admin-api/capital-flows',
  auth: 'admin',
  permission: 'payment:flow:read',
  summary: '资金流水',
  tags: ['payment'],
  query: capitalFlowListQuery,
  response: pagedCapitalFlows,
  examples: [
    {
      name: 'default',
      query: { page: 1, pageSize: 20 },
      response: { items: [capitalFlowExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const paymentAdminCapitalFlowSummary = defineRoute({
  id: 'payment.adminCapitalFlowSummary',
  method: 'GET',
  path: '/admin-api/capital-flows/summary',
  auth: 'admin',
  permission: 'payment:flow:read',
  summary: '资金流水汇总',
  tags: ['payment'],
  query: capitalFlowSummaryQuery,
  response: capitalFlowSummary,
  examples: [
    {
      name: 'february',
      query: { occurredFrom: '2026-02-01T00:00:00+08:00', occurredTo: '2026-03-01T00:00:00+08:00' },
      response: {
        inAmount: '128600.00',
        outAmount: '3120.00',
        netAmount: '125480.00',
        count: 1342,
      },
    },
  ],
});

export const paymentAdminEffectList = defineRoute({
  id: 'payment.adminEffectList',
  method: 'GET',
  path: '/admin-api/payment-effects',
  auth: 'admin',
  permission: 'payment:effect:handle',
  summary: '待人工处理的支付任务',
  tags: ['payment'],
  query: paymentEffectListQuery,
  response: pagedPaymentEffects,
  examples: [
    {
      name: 'needs-a-human',
      query: { page: 1, pageSize: 20, status: 'unknown' },
      response: { items: [paymentEffectExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

export const paymentAdminEffectRetry = defineRoute({
  id: 'payment.adminEffectRetry',
  method: 'POST',
  path: '/admin-api/payment-effects/:id/retry',
  auth: 'admin',
  permission: 'payment:effect:handle',
  summary: '重跑待人工处理的任务',
  tags: ['payment'],
  params: paymentIdParams,
  body: z.object({}).default({}),
  response: paymentEffectRetryResult,
  errors: ['PAYMENT_EFFECT_NOT_FOUND'],
  examples: [
    {
      name: 'succeeded',
      params: { id: '4410' },
      body: {},
      response: {
        effect: {
          ...paymentEffectExample,
          status: 'done',
          lastError: null,
          lastErrorSummary: null,
        },
        succeeded: true,
        message: '已重新排队，几秒内由后台执行，结果请稍后在列表里查看',
      },
    },
    {
      name: 'already-done',
      params: { id: '4410' },
      body: {},
      response: {
        effect: {
          ...paymentEffectExample,
          status: 'done',
          lastError: null,
          lastErrorSummary: null,
        },
        succeeded: false,
        message: '该任务已经执行成功，不需要再重试',
      },
    },
  ],
});
