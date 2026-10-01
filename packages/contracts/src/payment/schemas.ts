import { z } from 'zod';
import { id, instant, money, pageQuery, paged, sortQuery } from '../_conventions/common';

/**
 * Shapes shared by the payment routes.
 *
 * The enums are the PostgreSQL enums of `db/src/schema/payment.ts`, spelled the
 * same way. They are *not* imported from `@shop/db` — contracts are the bottom
 * layer — so `payment.service.ts` keeps the pair honest by assigning one to the
 * other, and stops compiling if they drift.
 *
 * WeChat Pay v3 is the only gateway. There is no `payType` field anywhere here:
 * balance, Alipay, AllInPay and offline payment are not offered.
 */

// ---------------------------------------------------------------------------
// enums
// ---------------------------------------------------------------------------

/** Which WeChat trade type an attempt was created with. */
export const paymentChannel = z.enum(['wechat_mini', 'wechat_oa', 'wechat_h5']);
export type PaymentChannel = z.infer<typeof paymentChannel>;

/**
 * The attempt lifecycle. `unknown` is never resolved by guessing — only by
 * querying the frozen `outTradeNo` (PAYC-002).
 */
export const paymentAttemptStatus = z.enum([
  'creating',
  'submitted',
  'paid',
  'closing',
  'closed',
  'failed',
  'unknown',
]);
export type PaymentAttemptStatus = z.infer<typeof paymentAttemptStatus>;

export const paymentExceptionReason = z.enum([
  'duplicate_payment',
  'cancelled_order_payment',
  'unmatched_payment',
  'amount_mismatch',
]);
export type PaymentExceptionReason = z.infer<typeof paymentExceptionReason>;

export const paymentExceptionStatus = z.enum([
  'open',
  'refunding',
  'refunded',
  'refund_unknown',
  'refund_failed',
  'ignored',
]);
export type PaymentExceptionStatus = z.infer<typeof paymentExceptionStatus>;

export const capitalFlowKind = z.enum(['order_payment', 'order_refund', 'exception_refund']);
export type CapitalFlowKind = z.infer<typeof capitalFlowKind>;

export const capitalFlowDirection = z.enum(['in', 'out']);
export type CapitalFlowDirection = z.infer<typeof capitalFlowDirection>;

// ---------------------------------------------------------------------------
// storefront: starting a payment
// ---------------------------------------------------------------------------

/**
 * `POST /api/v1/orders/:id/payments`.
 *
 * `openid` is optional and only consulted when the caller's WeChat identity is
 * not yet bound in `wechat_identities` — the mini-program and the OA both hand
 * the server a code first, and the bound identity always wins. A shopper cannot
 * pay into somebody else's openid by sending one: the attempt is created with
 * `payerUserId = ctx.actor.id` either way.
 */
export const startPaymentBody = z.object({
  channel: paymentChannel,
  /** Fallback openid for `wechat_mini` / `wechat_oa` when no identity is bound yet. */
  openid: z.string().min(1).max(64).optional(),
  /**
   * `wechat_h5` only: where the WeChat cashier sends the shopper back.
   * Must be same-origin with the shop; the server rejects anything else.
   */
  returnUrl: z.string().url().max(512).optional(),
});
export type StartPaymentBody = z.infer<typeof startPaymentBody>;

/**
 * What a mini-program or OA client feeds to `wx.requestPayment` / JSSDK
 * `chooseWXPay`.
 *
 * The key names are WeChat's, not ours — `timeStamp` really is camel-cased that
 * way and `package` really is a reserved word — because the mini program
 * (`apps/mini/src/platform/runtime.tsx`) forwards them as is to
 * `wx.requestPayment`. `signType` is `RSA` and only `RSA`: v2's MD5 is not
 * supported.
 */
export const jsapiPayParams = z.object({
  appId: z.string(),
  timeStamp: z.string(),
  nonceStr: z.string(),
  package: z.string(),
  signType: z.literal('RSA'),
  paySign: z.string(),
});
export type JsapiPayParams = z.infer<typeof jsapiPayParams>;

/**
 * The answer to "let me pay for this order".
 *
 * `alreadyPaid` exists because a shopper who taps 支付 on an order that a
 * callback just settled must be told 已支付 rather than handed a second payment
 * intent (CLIENT-001). In that case `jsapi` and `h5Url` are both null.
 */
export const paymentIntent = z.object({
  attemptId: id,
  orderId: id,
  /** The merchant order number. Frozen for the life of the attempt. */
  outTradeNo: z.string(),
  channel: paymentChannel,
  amount: money,
  status: paymentAttemptStatus,
  alreadyPaid: z.boolean(),
  /** Present for `wechat_mini` and `wechat_oa`. */
  jsapi: jsapiPayParams.nullable(),
  /** Present for `wechat_h5`: the WeChat cashier URL to redirect to. */
  h5Url: z.string().nullable(),
  /** When the gateway order expires; after this the shopper must start a new attempt. */
  expiresAt: instant.nullable(),
});
export type PaymentIntent = z.infer<typeof paymentIntent>;

/**
 * Cashier polling. Deliberately thin: the storefront asks "did my money land",
 * not "what does the gateway think", and a `pending` answer never triggers a
 * gateway call from an unauthenticated poll loop.
 */
export const paymentStatusResult = z.object({
  outTradeNo: z.string(),
  orderId: id,
  status: paymentAttemptStatus,
  /** `true` once the *order* is paid, which is the only thing the cashier screen cares about. */
  paid: z.boolean(),
  paidAt: instant.nullable(),
});
export type PaymentStatusResult = z.infer<typeof paymentStatusResult>;

export const paymentOutTradeNoParams = z.object({
  outTradeNo: z.string().min(1).max(64),
});

export const orderIdParams = z.object({ id });
export const paymentIdParams = z.object({ id });

/** Every webhook answers WeChat's own envelope: `{code, message}` with 200 or 4xx/5xx. */
export const webhookAck = z.object({
  code: z.enum(['SUCCESS', 'FAIL']),
  message: z.string(),
});
export type WebhookAck = z.infer<typeof webhookAck>;

// ---------------------------------------------------------------------------
// admin: attempts
// ---------------------------------------------------------------------------

export const paymentAttemptListItem = z.object({
  id,
  orderId: id,
  orderNo: z.string(),
  outTradeNo: z.string(),
  channel: paymentChannel,
  status: paymentAttemptStatus,
  mchId: z.string(),
  amount: money,
  transactionId: z.string().nullable(),
  payerUserId: id.nullable(),
  lastResult: z.string().nullable(),
  paidAt: instant.nullable(),
  closedConfirmedAt: instant.nullable(),
  createdAt: instant,
});
export type PaymentAttemptListItem = z.infer<typeof paymentAttemptListItem>;

export const paymentAttemptListQuery = pageQuery
  .extend({
    orderId: id.optional(),
    outTradeNo: z.string().max(64).optional(),
    transactionId: z.string().max(64).optional(),
    status: z.union([paymentAttemptStatus, z.array(paymentAttemptStatus)]).optional(),
    channel: paymentChannel.optional(),
    createdFrom: instant.optional(),
    createdTo: instant.optional(),
  })
  .extend(sortQuery(['id', 'createdAt', 'amount']).shape);
export type PaymentAttemptListQuery = z.infer<typeof paymentAttemptListQuery>;

export const pagedPaymentAttempts = paged(paymentAttemptListItem);

// ---------------------------------------------------------------------------
// admin: payment exceptions
// ---------------------------------------------------------------------------

/**
 * Money the shop holds but cannot book against an order.
 *
 * `orderId` and `paymentAttemptId` are nullable on purpose: a notification with
 * an unknown merchant order number still gets a row, because the money exists
 * whether or not we can attribute it (PAY-011).
 */
export const paymentExceptionListItem = z.object({
  id,
  orderId: id.nullable(),
  orderNo: z.string().nullable(),
  paymentAttemptId: id.nullable(),
  mchId: z.string(),
  transactionId: z.string(),
  outTradeNo: z.string().nullable(),
  reason: paymentExceptionReason,
  status: paymentExceptionStatus,
  paidAmount: money,
  /** The stable refund number. Generated once and reused on every retry. */
  refundNo: z.string().nullable(),
  operatorAdminId: id.nullable(),
  note: z.string().nullable(),
  refundedAt: instant.nullable(),
  resolvedAt: instant.nullable(),
  alarmedAt: instant.nullable(),
  createdAt: instant,
  /**
   * Why the refund has not gone back, for a row still waiting on one
   * (`refund_failed`, `refund_unknown`): the Chinese line staff read, and the
   * raw text behind 技术详情. `null` once the row is settled or ignored.
   */
  lastErrorSummary: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type PaymentExceptionListItem = z.infer<typeof paymentExceptionListItem>;

export const paymentExceptionDetail = paymentExceptionListItem.extend({
  /** What the gateway last said about the refund of this exception, for 技术详情. Never a secret. */
  refundRequest: z.record(z.string(), z.unknown()).nullable(),
  /** The notification context as it arrived: trade type, openid, client ip. */
  context: z.record(z.string(), z.unknown()),
});
export type PaymentExceptionDetail = z.infer<typeof paymentExceptionDetail>;

export const paymentExceptionListQuery = pageQuery
  .extend({
    status: z.union([paymentExceptionStatus, z.array(paymentExceptionStatus)]).optional(),
    reason: paymentExceptionReason.optional(),
    keyword: z.string().trim().max(64).optional(),
    createdFrom: instant.optional(),
    createdTo: instant.optional(),
  })
  .extend(sortQuery(['id', 'createdAt', 'paidAmount']).shape);
export type PaymentExceptionListQuery = z.infer<typeof paymentExceptionListQuery>;

export const pagedPaymentExceptions = paged(paymentExceptionListItem);

export const paymentExceptionRefundBody = z.object({
  /** Shown on the operator's timeline, not sent to WeChat. */
  note: z.string().max(255).optional(),
});
export type PaymentExceptionRefundBody = z.infer<typeof paymentExceptionRefundBody>;

export const paymentExceptionIgnoreBody = z.object({
  /** Required: "why did we keep this money" is the whole point of the row. */
  note: z.string().min(1).max(255),
});
export type PaymentExceptionIgnoreBody = z.infer<typeof paymentExceptionIgnoreBody>;

// ---------------------------------------------------------------------------
// admin: capital flows
// ---------------------------------------------------------------------------

export const capitalFlowListItem = z.object({
  id,
  kind: capitalFlowKind,
  /** The gateway-facing number that identifies the movement. Unique per `kind`. */
  reference: z.string(),
  direction: capitalFlowDirection,
  amount: money,
  orderId: id.nullable(),
  orderNo: z.string().nullable(),
  userId: id.nullable(),
  mchId: z.string().nullable(),
  transactionId: z.string().nullable(),
  note: z.string().nullable(),
  occurredAt: instant,
});
export type CapitalFlowListItem = z.infer<typeof capitalFlowListItem>;

export const capitalFlowListQuery = pageQuery
  .extend({
    kind: z.union([capitalFlowKind, z.array(capitalFlowKind)]).optional(),
    direction: capitalFlowDirection.optional(),
    orderId: id.optional(),
    userId: id.optional(),
    keyword: z.string().trim().max(64).optional(),
    occurredFrom: instant.optional(),
    occurredTo: instant.optional(),
  })
  .extend(sortQuery(['id', 'occurredAt', 'amount']).shape);
export type CapitalFlowListQuery = z.infer<typeof capitalFlowListQuery>;

export const pagedCapitalFlows = paged(capitalFlowListItem);

/**
 * The same filter without the page: the summary is over everything that
 * matches, which is the whole point of showing it above the table.
 */
export const capitalFlowSummaryQuery = capitalFlowListQuery.omit({ page: true, pageSize: true });
export type CapitalFlowSummaryQuery = z.infer<typeof capitalFlowSummaryQuery>;

/** The three numbers the finance page shows above the table, for the same filter. */
export const capitalFlowSummary = z.object({
  inAmount: money,
  outAmount: money,
  netAmount: money,
  count: z.number().int().min(0),
});
export type CapitalFlowSummary = z.infer<typeof capitalFlowSummary>;

// ---------------------------------------------------------------------------
// admin: effects that need a human
// ---------------------------------------------------------------------------

/**
 * The effect scopes the "需人工处理" console lists: every ledger scope whose
 * parked row means something did not happen — money, refunds, orders, the
 * WeChat 发货信息录入 (`shipment`), group-buy and presale settlement, content
 * security checks and WeChat's pushes. `notification` is left out on purpose:
 * it has its own send log, and a subscribe message nobody could deliver is not
 * an operator's to retry.
 */
export const paymentEffectScopes = [
  'payment',
  'refund',
  'order',
  'shipment',
  'groupbuy',
  'presale',
  'content-security',
  'wechat-mini-push',
] as const;
export type PaymentEffectScope = (typeof paymentEffectScopes)[number];

/** One row of the "需人工处理" console (scopes: `paymentEffectScopes`). */
export const paymentEffectListItem = z.object({
  id,
  scope: z.string(),
  scopeId: z.string(),
  eventType: z.string(),
  status: z.enum(['pending', 'done', 'unknown']),
  attempts: z.number().int().min(0),
  /**
   * Raw diagnostic text (a gateway's errmsg, a channel id, an exception
   * message), for whoever debugs it. Staff-only and shown only under 技术详情:
   * the screens show `lastErrorSummary`.
   */
  lastError: z.string().nullable(),
  /** The same failure in Chinese, what staff read. Non-null exactly when `lastError` is. */
  lastErrorSummary: z.string().nullable(),
  nextRunAt: instant.nullable(),
  createdAt: instant,
  updatedAt: instant,
});
export type PaymentEffectListItem = z.infer<typeof paymentEffectListItem>;

export const paymentEffectListQuery = pageQuery.extend({
  status: z.enum(['pending', 'done', 'unknown']).default('unknown'),
  scope: z.enum(paymentEffectScopes).optional(),
  eventType: z.string().max(64).optional(),
});
export type PaymentEffectListQuery = z.infer<typeof paymentEffectListQuery>;

export const pagedPaymentEffects = paged(paymentEffectListItem);

export const paymentEffectRetryResult = z.object({
  effect: paymentEffectListItem,
  /**
   * `true` when the row was put back in the queue. The handler is not run in
   * the request, so this never claims the work succeeded; `false` means the row
   * had already left 需人工处理, and `message` says where it is.
   */
  succeeded: z.boolean(),
  /** What to tell staff, in Chinese. */
  message: z.string(),
});
export type PaymentEffectRetryResult = z.infer<typeof paymentEffectRetryResult>;

// ---------------------------------------------------------------------------
// the WeChat v3 notification envelope
// ---------------------------------------------------------------------------

/**
 * The outer envelope of every v3 callback, parsed from the **raw request body**
 * *after* its platform signature verified.
 *
 * It is exported from the contracts rather than the service so every party to
 * a v3 callback can describe the same shape, but no route declares it as a
 * `body`: `handle()` would consume the stream to parse it and the signature is
 * computed over the exact bytes. The webhook route files read
 * `ctx.request.text()` themselves. See `payment.webhook.contract.ts`.
 */
export const wechatNotifyEnvelope = z.object({
  id: z.string(),
  create_time: z.string(),
  event_type: z.string(),
  resource_type: z.string(),
  summary: z.string().optional(),
  resource: z.object({
    algorithm: z.string(),
    ciphertext: z.string(),
    nonce: z.string(),
    associated_data: z.string().optional(),
    original_type: z.string().optional(),
  }),
});
export type WechatNotifyEnvelope = z.infer<typeof wechatNotifyEnvelope>;

// ---------------------------------------------------------------------------
// examples
// ---------------------------------------------------------------------------

export const jsapiPayParamsExample: JsapiPayParams = {
  appId: 'wx0000000000000001',
  timeStamp: '1767225600',
  nonceStr: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  package: 'prepay_id=wx2612345678901234567890123456',
  signType: 'RSA',
  paySign: 'S3TJqKXZs2Yk0m6cM3s1J7xQd5r6Z0m0b4n3c2v1x9y8w7u6t5r4e3w2q1',
};

export const paymentIntentExample: PaymentIntent = {
  attemptId: '5001',
  orderId: '3001',
  outTradeNo: 'P2602261200003001A7F3',
  channel: 'wechat_mini',
  amount: '99.00',
  status: 'submitted',
  alreadyPaid: false,
  jsapi: jsapiPayParamsExample,
  h5Url: null,
  expiresAt: '2026-02-26T12:30:00+08:00',
};

export const paymentAttemptExample: PaymentAttemptListItem = {
  id: '5001',
  orderId: '3001',
  orderNo: 'SO2602261159001',
  outTradeNo: 'P2602261200003001A7F3',
  channel: 'wechat_mini',
  status: 'paid',
  mchId: '1900000001',
  amount: '99.00',
  transactionId: '4200001234202602261234567890',
  payerUserId: '77',
  lastResult: 'notify: SUCCESS',
  paidAt: '2026-02-26T12:02:31+08:00',
  closedConfirmedAt: null,
  createdAt: '2026-02-26T12:00:00+08:00',
};

export const paymentExceptionExample: PaymentExceptionListItem = {
  id: '11',
  orderId: '3001',
  orderNo: 'SO2602261159001',
  paymentAttemptId: '5002',
  mchId: '1900000001',
  transactionId: '4200001234202602261234567891',
  outTradeNo: 'P2602261210003001B8E4',
  reason: 'cancelled_order_payment',
  status: 'open',
  paidAmount: '99.00',
  refundNo: null,
  operatorAdminId: null,
  note: null,
  refundedAt: null,
  resolvedAt: null,
  alarmedAt: '2026-02-26T12:20:00+08:00',
  createdAt: '2026-02-26T12:12:04+08:00',
  lastErrorSummary: null,
  lastError: null,
};

export const paymentExceptionDetailExample: PaymentExceptionDetail = {
  ...paymentExceptionExample,
  refundRequest: null,
  context: { tradeType: 'JSAPI', openid: 'oFakeOpenid0000000000000001' },
};

export const capitalFlowExample: CapitalFlowListItem = {
  id: '901',
  kind: 'order_payment',
  reference: 'P2602261200003001A7F3',
  direction: 'in',
  amount: '99.00',
  orderId: '3001',
  orderNo: 'SO2602261159001',
  userId: '77',
  mchId: '1900000001',
  transactionId: '4200001234202602261234567890',
  note: '订单支付 SO2602261159001',
  occurredAt: '2026-02-26T12:02:31+08:00',
};

export const paymentEffectExample: PaymentEffectListItem = {
  id: '4410',
  scope: 'shipment',
  scopeId: '3001',
  eventType: 'wechat.uploadShipping',
  status: 'unknown',
  attempts: 8,
  lastError: '微信发货信息录入失败: -1 system error',
  lastErrorSummary: '微信没有接受发货信息（错误码 -1），请联系技术人员查看服务器日志',
  nextRunAt: null,
  createdAt: '2026-02-26T12:02:31+08:00',
  updatedAt: '2026-02-26T13:10:00+08:00',
};
