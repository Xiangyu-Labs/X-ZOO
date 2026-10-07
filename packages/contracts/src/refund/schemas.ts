import { z } from 'zod';
import { id, instant, money, pageQuery, paged, sortQuery } from '../_conventions/common';
import { orderRef } from '../order/order.ref.schemas';

/**
 * Shapes shared by the refund routes.
 *
 * The enums mirror `db/src/schema/refund.ts`. The two rules this whole domain
 * hangs off are visible in the shapes themselves:
 *
 *  - a refund is **per order item with quantities**; there is no order
 *    splitting, so nothing here has a `childOrderId`;
 *  - `outRefundNo` and `amount` are **frozen at creation** and appear on every
 *    read, because "the number we already sent" is the only safe thing to query
 *    an unknown result with (REFUND-005/006).
 */

// ---------------------------------------------------------------------------
// enums
// ---------------------------------------------------------------------------

/** What the buyer is asking for. */
export const refundKind = z.enum(['refund_only', 'return_and_refund']);
export type RefundKind = z.infer<typeof refundKind>;

export const refundStatus = z.enum([
  'applied',
  'approved',
  'rejected',
  'processing',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
]);
export type RefundStatus = z.infer<typeof refundStatus>;

/** Where the returned goods are. `not_required` for a `refund_only`. */
export const refundReturnStage = z.enum([
  'not_required',
  'awaiting_shipment',
  'shipped_back',
  'received',
]);
export type RefundReturnStage = z.infer<typeof refundReturnStage>;

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------

/** One line the shopper may put into after-sales, as the apply screen sees it. */
export const refundableItem = z.object({
  orderItemId: id,
  itemKey: z.string(),
  productName: z.string(),
  productImageUrl: z.string(),
  specText: z.string(),
  quantity: z.number().int().min(1),
  /** Already refunded on earlier requests. */
  refundedQuantity: z.number().int().min(0),
  /** Already dispatched, which decides whether a return is required. */
  shippedQuantity: z.number().int().min(0),
  /** How many units may still go into a new request. */
  refundableQuantity: z.number().int().min(0),
  unitPrice: money,
  /** This line's share of the order total, after its share of the coupon discount. */
  totalAmount: money,
  /** The most this line could give back right now. */
  refundableAmount: money,
  /** `null` when refundable; a `REFUND_*` code when not, so the UI can grey the row with a reason. */
  blockedReason: z.string().nullable(),
});
export type RefundableItem = z.infer<typeof refundableItem>;

/**
 * The order is a path segment rather than a query parameter: it is the one
 * thing this screen cannot be asked without, and a missing path segment is a
 * 404 rather than a 422 the client has to explain.
 */
export const refundableItemsParams = z.object({ orderId: orderRef });
export type RefundableItemsParams = z.infer<typeof refundableItemsParams>;

/**
 * The apply screen in one call: what may be returned, the freight rule, and
 * how much of the order's money is still un-refunded.
 */
export const refundableItemsResult = z.object({
  orderId: id,
  orderNo: z.string(),
  paidAmount: money,
  refundedAmount: money,
  /** `paidAmount - refundedAmount`: the ceiling every new request is measured against. */
  refundableAmount: money,
  /** Freight is refundable only while nothing has shipped. */
  freightAmount: money,
  freightRefundable: z.boolean(),
  items: z.array(refundableItem),
});
export type RefundableItemsResult = z.infer<typeof refundableItemsResult>;

export const refundLine = z.object({
  orderItemId: id,
  quantity: z.number().int().min(1).max(10_000),
});
export type RefundLine = z.infer<typeof refundLine>;

/** One line of a refund as it comes back on a detail read. */
export const refundItem = z.object({
  orderItemId: id,
  productName: z.string(),
  productImageUrl: z.string(),
  specText: z.string(),
  quantity: z.number().int().min(1),
  /** This line's share of `refunds.amount`. The shares add up to it exactly. */
  amount: money,
});
export type RefundItem = z.infer<typeof refundItem>;

// ---------------------------------------------------------------------------
// applying
// ---------------------------------------------------------------------------

/**
 * `POST /api/v1/refunds`.
 *
 * Note what is *not* here: an amount. The shopper picks lines and quantities;
 * the service computes the money from the frozen order lines and its own
 * freight rule. An amount taken from the request would let a crafted body ask
 * for more than was paid.
 */
export const refundApplyBody = z.object({
  orderId: id,
  kind: refundKind,
  lines: z.array(refundLine).min(1).max(100),
  /** One of `GET /api/v1/refund-reasons`, or free text the operator will read. */
  reason: z.string().min(1).max(255),
  explanation: z.string().max(512).optional(),
  /** Evidence photos: each a URL `POST /api/v1/uploads` returned (REFUND-014). */
  images: z.array(z.string().max(512)).max(9).default([]),
  /** Ask for the shipping fee back too. Only honoured while nothing has shipped. */
  includeFreight: z.boolean().default(false),
});
export type RefundApplyBody = z.infer<typeof refundApplyBody>;

export const refundReturnShipmentBody = z.object({
  expressCompanyId: id,
  trackingNo: z.string().min(1).max(64),
  phone: z.string().max(20).optional(),
});
export type RefundReturnShipmentBody = z.infer<typeof refundReturnShipmentBody>;

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/** What a shopper sees in 退款/售后. */
export const refundListItem = z.object({
  id,
  /** Customer-facing after-sales number. */
  refundNo: z.string(),
  orderId: id,
  orderNo: z.string(),
  kind: refundKind,
  status: refundStatus,
  returnStage: refundReturnStage,
  quantity: z.number().int().min(1),
  /** Frozen at creation and never recomputed. */
  amount: money,
  /** What the gateway actually gave back so far. */
  refundedAmount: money,
  includesFreight: z.boolean(),
  reason: z.string().nullable(),
  rejectReason: z.string().nullable(),
  /**
   * Opened by the shop itself (a failed group buy, an expired presale, an
   * operator's 发起售后), not by the shopper — who therefore cannot withdraw it.
   */
  isAutomatic: z.boolean(),
  items: z.array(refundItem),
  createdAt: instant,
  succeededAt: instant.nullable(),
});
export type RefundListItem = z.infer<typeof refundListItem>;

/** The detail adds the return shipment and the timeline. */
export const refundLogEntry = z.object({
  toStatus: refundStatus,
  message: z.string().nullable(),
  createdAt: instant,
});
export type RefundLogEntry = z.infer<typeof refundLogEntry>;

export const refundDetail = refundListItem.extend({
  explanation: z.string().nullable(),
  images: z.array(z.string()),
  returnExpressCompanyId: id.nullable(),
  returnExpressCompanyName: z.string().nullable(),
  returnTrackingNo: z.string().nullable(),
  returnPhone: z.string().nullable(),
  /** Where to send the goods back to. Present once a `return_and_refund` is approved. */
  returnAddress: z
    .object({
      name: z.string(),
      phone: z.string(),
      address: z.string(),
    })
    .nullable(),
  logs: z.array(refundLogEntry),
});
export type RefundDetail = z.infer<typeof refundDetail>;

/**
 * The admin row adds who asked, the merchant-facing numbers, and the operator
 * trail. `outRefundNo` is admin-only: a shopper has no use for it and it is the
 * number support quotes to WeChat.
 */
export const adminRefundListItem = refundListItem.extend({
  /**
   * Opened by an automatic process (a failed group buy, an expired presale).
   * Narrower than the shopper's flag: a refund an operator opened is
   * `initiatedByAdminId` instead.
   */
  isAutomatic: z.boolean(),
  /** The operator who opened it from the order screen (商家发起); null for a buyer's request. */
  initiatedByAdminId: id.nullable(),
  initiatedByAdminName: z.string().nullable(),
  userId: id,
  userNickname: z.string().nullable(),
  outRefundNo: z.string(),
  gatewayRefundId: z.string().nullable(),
  paymentAttemptId: id.nullable(),
  adminRemark: z.string().nullable(),
  /**
   * Raw diagnostic text (the gateway's code and text, a refund status, a
   * transport error), for whoever debugs it. Staff-only and shown only under 技术详情:
   * the screens show `lastErrorSummary`.
   */
  lastError: z.string().nullable(),
  /** The same failure in Chinese, what staff read. Non-null exactly when `lastError` is. */
  lastErrorSummary: z.string().nullable(),
  reviewedByAdminId: id.nullable(),
  reviewedAt: instant.nullable(),
  failedAt: instant.nullable(),
  cancelledAt: instant.nullable(),
  updatedAt: instant,
});
export type AdminRefundListItem = z.infer<typeof adminRefundListItem>;

export const adminRefundDetail = adminRefundListItem.extend({
  explanation: z.string().nullable(),
  images: z.array(z.string()),
  returnExpressCompanyId: id.nullable(),
  returnExpressCompanyName: z.string().nullable(),
  returnTrackingNo: z.string().nullable(),
  returnPhone: z.string().nullable(),
  /**
   * The address this buyer was actually told to ship to, frozen on the row at
   * the approval. The operator sees the same string the buyer does, which is
   * the only way a "where did you send it?" conversation can end.
   */
  returnAddress: z
    .object({
      name: z.string(),
      phone: z.string(),
      address: z.string(),
    })
    .nullable(),
  logs: z.array(refundLogEntry),
});
export type AdminRefundDetail = z.infer<typeof adminRefundDetail>;

export const myRefundListQuery = pageQuery.extend({
  /** The three tabs of 退款列表. `open` folds in everything still in flight. */
  state: z.enum(['all', 'open', 'succeeded', 'closed']).default('all'),
});
export type MyRefundListQuery = z.infer<typeof myRefundListQuery>;

export const pagedMyRefunds = paged(refundListItem);

export const adminRefundListQuery = pageQuery
  .extend({
    status: z.union([refundStatus, z.array(refundStatus)]).optional(),
    kind: refundKind.optional(),
    returnStage: refundReturnStage.optional(),
    orderId: id.optional(),
    userId: id.optional(),
    /** Matches the after-sales number, the order number or the merchant refund number. */
    keyword: z.string().trim().max(64).optional(),
    createdFrom: instant.optional(),
    createdTo: instant.optional(),
  })
  .extend(sortQuery(['id', 'createdAt', 'amount']).shape);
export type AdminRefundListQuery = z.infer<typeof adminRefundListQuery>;

export const pagedAdminRefunds = paged(adminRefundListItem);

export const refundIdParams = z.object({ id });

// ---------------------------------------------------------------------------
// admin actions
// ---------------------------------------------------------------------------

export const refundApproveBody = z.object({
  /** Shown to the shopper next to 同意退款. */
  remark: z.string().max(255).optional(),
  /**
   * `return_and_refund` only: where the goods go back to, instead of 售后设置.
   * Redirecting goods also needs `refund:config:write`.
   */
  returnAddress: z
    .object({
      name: z.string().min(1).max(32),
      phone: z.string().min(1).max(20),
      address: z.string().min(1).max(255),
    })
    .optional(),
});
export type RefundApproveBody = z.infer<typeof refundApproveBody>;

export const refundRejectBody = z.object({
  /** Required: the shopper is told why, and `refunds_rejected_needs_reason` enforces it. */
  rejectReason: z.string().min(1).max(255),
});
export type RefundRejectBody = z.infer<typeof refundRejectBody>;

export const refundRemarkBody = z.object({
  adminRemark: z.string().max(255),
});
export type RefundRemarkBody = z.infer<typeof refundRemarkBody>;

/**
 * `POST /admin-api/orders/:id/refunds` — 商家发起售后.
 *
 * The buyer's apply body without the evidence. The operator picks lines and
 * quantities and the service prices them exactly as it prices a buyer's
 * request (REFUND-005); a 仅退款 may then settle for less (`amount`), never
 * more. It opens already approved, so a 仅退款 goes to the gateway and a
 * 退货退款 waits for the goods at the address in 售后设置.
 */
export const adminRefundCreateBody = z
  .object({
    kind: refundKind,
    lines: z.array(refundLine).min(1).max(100),
    /**
     * 仅退款 only: what the shop agreed to give back, at most what the lines (and
     * freight) are worth. Absent means all of it. The units still count as
     * refunded; the rest of their money is not refundable later.
     */
    amount: money.optional(),
    /** Shown to the buyer as the reason for the after-sales. */
    reason: z.string().trim().min(1, '请填写售后原因').max(255),
    /** Staff-only note, the same field as 售后备注. */
    remark: z.string().max(255).optional(),
    /** Only honoured while nothing has shipped and the request takes everything left. */
    includeFreight: z.boolean().default(false),
  })
  .refine((body) => body.amount === undefined || body.kind === 'refund_only', {
    path: ['amount'],
    message: '退货退款按商品金额退款，不能另填金额',
  });
export type AdminRefundCreateBody = z.infer<typeof adminRefundCreateBody>;

/** 撤销 a refund the shop opened, before any money or goods have moved. */
export const adminRefundWithdrawBody = z.object({
  /** Shown to the buyer. */
  reason: z.string().trim().min(1, '请填写撤销原因').max(255),
});
export type AdminRefundWithdrawBody = z.infer<typeof adminRefundWithdrawBody>;

export const adminRefundOrderParams = z.object({ id });

export const refundReceiveReturnBody = z.object({
  remark: z.string().max(255).optional(),
});
export type RefundReceiveReturnBody = z.infer<typeof refundReceiveReturnBody>;

/** The list of canned reasons the apply screen offers. */
export const refundReasonList = z.object({
  items: z.array(z.string()),
});
export type RefundReasonList = z.infer<typeof refundReasonList>;

// ---------------------------------------------------------------------------
// examples
// ---------------------------------------------------------------------------

export const refundItemExample: RefundItem = {
  orderItemId: '7001',
  productName: '有机红富士苹果 5 斤装',
  productImageUrl: 'https://cdn.example/p/apple.jpg',
  specText: '5 斤 / 箱',
  quantity: 1,
  amount: '99.00',
};

export const refundExample: RefundListItem = {
  id: '601',
  refundNo: 'RF2602261300000601',
  orderId: '3001',
  orderNo: 'SO2602261159001',
  kind: 'return_and_refund',
  status: 'applied',
  returnStage: 'awaiting_shipment',
  quantity: 1,
  amount: '99.00',
  refundedAmount: '0.00',
  includesFreight: false,
  reason: '商品破损',
  rejectReason: null,
  isAutomatic: false,
  items: [refundItemExample],
  createdAt: '2026-02-26T13:00:00+08:00',
  succeededAt: null,
};

export const refundDetailExample: RefundDetail = {
  ...refundExample,
  explanation: '收到时箱子被压坏，里面有三个苹果烂了',
  images: ['https://cdn.example/u/77/refund-601-1.jpg'],
  returnExpressCompanyId: null,
  returnExpressCompanyName: null,
  returnTrackingNo: null,
  returnPhone: null,
  returnAddress: null,
  logs: [
    { toStatus: 'applied', message: '买家发起退款申请', createdAt: '2026-02-26T13:00:00+08:00' },
  ],
};

export const adminRefundExample: AdminRefundListItem = {
  ...refundExample,
  userId: '77',
  userNickname: '小明',
  outRefundNo: 'R2602261300000601C4D2',
  gatewayRefundId: null,
  paymentAttemptId: '5001',
  initiatedByAdminId: null,
  initiatedByAdminName: null,
  adminRemark: null,
  lastError: null,
  lastErrorSummary: null,
  reviewedByAdminId: null,
  reviewedAt: null,
  failedAt: null,
  cancelledAt: null,
  updatedAt: '2026-02-26T13:00:00+08:00',
};

export const adminRefundDetailExample: AdminRefundDetail = {
  ...adminRefundExample,
  explanation: '收到时箱子被压坏，里面有三个苹果烂了',
  images: ['https://cdn.example/u/77/refund-601-1.jpg'],
  returnExpressCompanyId: null,
  returnExpressCompanyName: null,
  returnTrackingNo: null,
  returnPhone: null,
  returnAddress: null,
  logs: [
    { toStatus: 'applied', message: '买家发起退款申请', createdAt: '2026-02-26T13:00:00+08:00' },
  ],
};

export const refundableItemExample: RefundableItem = {
  orderItemId: '7001',
  itemKey: 'L1',
  productName: '有机红富士苹果 5 斤装',
  productImageUrl: 'https://cdn.example/p/apple.jpg',
  specText: '5 斤 / 箱',
  quantity: 1,
  refundedQuantity: 0,
  shippedQuantity: 1,
  refundableQuantity: 1,
  unitPrice: '99.00',
  totalAmount: '99.00',
  refundableAmount: '99.00',
  blockedReason: null,
};

export const refundableItemsExample: RefundableItemsResult = {
  orderId: '3001',
  orderNo: 'SO2602261159001',
  paidAmount: '99.00',
  refundedAmount: '0.00',
  refundableAmount: '99.00',
  freightAmount: '0.00',
  freightRefundable: false,
  items: [refundableItemExample],
};
