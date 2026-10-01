'use client';

import type {
  CapitalFlowDirection,
  CapitalFlowKind,
  PaymentAttemptStatus,
  PaymentChannel,
  PaymentExceptionReason,
  PaymentExceptionStatus,
} from '@shop/contracts/payment/schemas';
import type { RefundKind, RefundReturnStage, RefundStatus } from '@shop/contracts/refund/schemas';

import type { StatusMap } from '@/admin/kit/status-tag';

/**
 * The payment and refund enums, in one file next to the pages that render them.
 *
 * One `StatusMap` per contract enum, shared by the table column, the filter bar
 * and the detail drawer, so a status can never read 退款中 on the list and
 * 处理中 on the drawer. The keys are the contract's own union members, so a
 * value removed from the contract is a compile error here rather than a blank
 * tag in front of an operator who is trying to find missing money.
 *
 * The colours are not decoration. Anything that means "money is somewhere we
 * cannot see" — `unknown`, `refund_unknown` — is red, because that is the one
 * state where waiting is the wrong instinct and someone has to go and look.
 */

export const PAYMENT_CHANNEL: StatusMap<PaymentChannel> = {
  wechat_mini: { label: '小程序', color: 'green' },
  wechat_oa: { label: '公众号', color: 'cyan' },
  wechat_h5: { label: 'H5', color: 'blue' },
};

export const PAYMENT_ATTEMPT_STATUS: StatusMap<PaymentAttemptStatus> = {
  creating: { label: '创建中', color: 'default' },
  submitted: { label: '待支付', color: 'processing' },
  paid: { label: '已支付', color: 'success' },
  closing: { label: '关闭中', color: 'warning' },
  closed: { label: '已关闭', color: 'default' },
  failed: { label: '失败', color: 'volcano' },
  unknown: { label: '结果未知', color: 'error' },
};

export const PAYMENT_EXCEPTION_REASON: StatusMap<PaymentExceptionReason> = {
  duplicate_payment: { label: '重复支付', color: 'gold' },
  cancelled_order_payment: { label: '订单已取消', color: 'orange' },
  unmatched_payment: { label: '无法匹配订单', color: 'volcano' },
  amount_mismatch: { label: '金额不符', color: 'red' },
};

export const PAYMENT_EXCEPTION_STATUS: StatusMap<PaymentExceptionStatus> = {
  open: { label: '待处理', color: 'error' },
  refunding: { label: '退款中', color: 'processing' },
  refunded: { label: '已退款', color: 'success' },
  refund_unknown: { label: '退款未知', color: 'error' },
  refund_failed: { label: '退款失败', color: 'volcano' },
  ignored: { label: '已忽略', color: 'default' },
};

export const CAPITAL_FLOW_KIND: StatusMap<CapitalFlowKind> = {
  order_payment: { label: '订单收款', color: 'success' },
  order_refund: { label: '订单退款', color: 'orange' },
  exception_refund: { label: '异常退款', color: 'volcano' },
};

export const CAPITAL_FLOW_DIRECTION: StatusMap<CapitalFlowDirection> = {
  in: { label: '收入', color: 'success' },
  out: { label: '支出', color: 'red' },
};

export const REFUND_KIND: StatusMap<RefundKind> = {
  refund_only: { label: '仅退款', color: 'blue' },
  return_and_refund: { label: '退货退款', color: 'geekblue' },
};

export const REFUND_STATUS: StatusMap<RefundStatus> = {
  applied: { label: '待审核', color: 'warning' },
  approved: { label: '已同意', color: 'processing' },
  rejected: { label: '已拒绝', color: 'default' },
  processing: { label: '退款中', color: 'processing' },
  succeeded: { label: '已退款', color: 'success' },
  failed: { label: '退款失败', color: 'volcano' },
  unknown: { label: '结果未知', color: 'error' },
  cancelled: { label: '买家撤销', color: 'default' },
};

export const REFUND_RETURN_STAGE: StatusMap<RefundReturnStage> = {
  not_required: { label: '无需退货', color: 'default' },
  awaiting_shipment: { label: '待买家寄回', color: 'warning' },
  shipped_back: { label: '买家已寄出', color: 'processing' },
  received: { label: '已收到退货', color: 'success' },
};

/** The effect console's three states. Narrower than the table's enum on purpose. */
export const EFFECT_STATUS: StatusMap<'pending' | 'done' | 'unknown'> = {
  pending: { label: '待执行', color: 'processing' },
  done: { label: '已完成', color: 'success' },
  unknown: { label: '需人工处理', color: 'error' },
};

/** `StatusMap` -> `Select` options, for the filter bar. */
export function optionsOf<K extends string>(map: StatusMap<K>): { value: K; label: string }[] {
  return (Object.keys(map) as K[]).map((value) => ({ value, label: map[value].label }));
}
