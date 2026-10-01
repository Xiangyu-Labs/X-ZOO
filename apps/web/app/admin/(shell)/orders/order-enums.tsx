'use client';

import type {
  InvoiceHeaderType,
  InvoiceStatus,
  InvoiceType,
  OrderChangeType,
  OrderOperatorKind,
  ShipmentDeliveryMode,
  ShipmentStatus,
} from '@shop/contracts/order/order.fulfil.schemas';
import type {
  OrderFulfillmentStatus,
  OrderKind,
  OrderRefundStatus,
  OrderStatus,
} from '@shop/contracts/order/schemas';
import type { StatusMap } from '@/admin/kit/status-tag';

/**
 * Every order enum, once, next to the pages that render them.
 *
 * The keys are the contract's own union members, so deleting a value from a
 * contract is a compile error here rather than a blank tag in production. And
 * because the table column, the filter bar and the detail page all read the
 * same map, 待发货 cannot mean one thing in the list and another in the header.
 */

export const ORDER_STATUS: StatusMap<OrderStatus> = {
  pending_payment: { label: '待付款', color: 'warning' },
  paid: { label: '待发货', color: 'processing' },
  shipped: { label: '待收货', color: 'blue' },
  received: { label: '已收货', color: 'cyan' },
  completed: { label: '已完成', color: 'success' },
  cancelled: { label: '已取消', color: 'default' },
  refunded: { label: '已退款', color: 'error' },
};

/**
 * The spelling is the database's (`orders_fulfillment_status`), not
 * `unshipped / partially_shipped / shipped` — renaming the enum would be a
 * migration.
 */
export const FULFILLMENT_STATUS: StatusMap<OrderFulfillmentStatus> = {
  unfulfilled: { label: '未发货', color: 'default' },
  partially_fulfilled: { label: '部分发货', color: 'warning' },
  fulfilled: { label: '已发货', color: 'success' },
};

export const REFUND_STATUS: StatusMap<OrderRefundStatus> = {
  none: { label: '无', color: 'default' },
  requested: { label: '退款中', color: 'warning' },
  partially_refunded: { label: '部分退款', color: 'orange' },
  refunded: { label: '已退款', color: 'error' },
};

export const ORDER_KIND: StatusMap<OrderKind> = {
  normal: { label: '普通', color: 'default' },
  groupbuy: { label: '拼团', color: 'magenta' },
  presale: { label: '预售', color: 'geekblue' },
};

export const DELIVERY_MODE: StatusMap<ShipmentDeliveryMode> = {
  express: { label: '快递发货', color: 'blue' },
  merchant_delivery: { label: '商家配送', color: 'cyan' },
  virtual: { label: '虚拟发货', color: 'purple' },
};

export const SHIPMENT_STATUS: StatusMap<ShipmentStatus> = {
  dispatched: { label: '已发货', color: 'processing' },
  delivered: { label: '已签收', color: 'success' },
  cancelled: { label: '已撤销', color: 'default' },
};

export const INVOICE_STATUS: StatusMap<InvoiceStatus> = {
  requested: { label: '待开票', color: 'warning' },
  issued: { label: '已开票', color: 'success' },
  rejected: { label: '已驳回', color: 'error' },
  cancelled: { label: '已取消', color: 'default' },
};

export const INVOICE_HEADER_TYPE: StatusMap<InvoiceHeaderType> = {
  personal: { label: '个人', color: 'default' },
  company: { label: '企业', color: 'blue' },
};

export const INVOICE_TYPE: StatusMap<InvoiceType> = {
  plain: { label: '普通发票', color: 'default' },
  special: { label: '专用发票', color: 'gold' },
};

export const OPERATOR_KIND: StatusMap<OrderOperatorKind> = {
  system: { label: '系统', color: 'default' },
  user: { label: '买家', color: 'blue' },
  admin: { label: '管理员', color: 'purple' },
  gateway: { label: '支付网关', color: 'cyan' },
};

/** The timeline's 32 change types. A label per row, so nothing renders as a raw enum. */
export const CHANGE_TYPE: Record<OrderChangeType, string> = {
  created: '创建订单',
  paid: '支付成功',
  pay_failed: '支付失败',
  cancelled: '取消订单',
  auto_cancelled: '超时自动取消',
  price_adjusted: '修改价格',
  address_updated: '修改收货地址',
  remark_updated: '修改备注',
  shipped: '发货',
  shipment_cancelled: '撤销发货',
  shipment_updated: '修改发货信息',
  virtual_delivered: '自动发货',
  received: '确认收货',
  auto_received: '自动确认收货',
  reviewed: '评价',
  completed: '订单完成',
  refund_applied: '申请退款',
  refund_approved: '同意退款',
  refund_rejected: '拒绝退款',
  refund_cancelled: '撤销退款',
  refund_succeeded: '退款成功',
  refund_failed: '退款失败',
  coupon_returned: '退回优惠券',
  coupon_granted: '赠送优惠券',
  invoice_requested: '申请开票',
  invoice_issued: '开票',
  invoice_rejected: '驳回开票',
  invoice_voided: '作废发票',
  groupbuy_joined: '参与拼团',
  groupbuy_succeeded: '拼团成功',
  groupbuy_failed: '拼团失败',
  hidden_by_user: '买家删除',
  deleted_by_admin: '后台删除',
};

/** `statusOptions()` wants `{value,label}`; the filter bars all take this shape. */
export const optionsOf = <T extends string>(map: StatusMap<T>): { value: T; label: string }[] =>
  Object.entries(map).map(([value, option]) => ({
    value: value as T,
    label: (option as { label: string }).label,
  }));
