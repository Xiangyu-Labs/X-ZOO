/**
 * Orders, shipments and refunds as the API returns them, for the order and after-sales page
 * tests. Plain objects typed by the contracts (which the app may only import as types).
 */
import type {
  OrderDetail,
  StorefrontOrderItem,
  StorefrontOrderListItem,
} from '@shop/contracts/order/schemas';
import type { Shipment, ShipmentTracking } from '@shop/contracts/order/order.fulfil.schemas';
import type {
  RefundableItem,
  RefundableItemsResult,
  RefundDetail,
  RefundListItem,
} from '@shop/contracts/refund/schemas';

export function orderItem(
  id: string,
  overrides: Partial<StorefrontOrderItem> = {},
): StorefrontOrderItem {
  return {
    id,
    itemKey: `sku-${id}`,
    productId: '11',
    skuId: '21',
    productName: `商品 ${id}`,
    productImageUrl: '/p.jpg',
    productKind: 'physical',
    specText: '标准装',
    skuImageUrl: null,
    unitName: '件',
    quantity: 1,
    unitPrice: '60.00',
    originalUnitPrice: null,
    discountAmount: '0.00',
    totalAmount: '60.00',
    refundedQuantity: 0,
    shippedQuantity: 0,
    adjustments: [],
    reviewed: false,
    reviewable: false,
    ...overrides,
  };
}

export function orderListItem(
  overrides: Partial<StorefrontOrderListItem> = {},
): StorefrontOrderListItem {
  return {
    id: '9001',
    orderNo: '202602011000000010123456',
    kind: 'normal',
    status: 'paid',
    fulfillmentStatus: 'unfulfilled',
    refundStatus: 'none',
    totalQuantity: 1,
    itemsAmount: '60.00',
    freightAmount: '0.00',
    couponDiscount: '0.00',
    payableAmount: '60.00',
    paidAmount: '60.00',
    payExpiresAt: null,
    createdAt: '2026-02-01T10:00:00+08:00',
    items: [orderItem('7001')],
    refundedAmount: '0.00',
    hasOpenRefund: false,
    groupbuyTeam: null,
    ...overrides,
  };
}

export function orderDetail(overrides: Partial<OrderDetail> = {}): OrderDetail {
  // What the server says (INVOICE-004): open once paid, until refunded or cancelled.
  const status = overrides.status ?? 'paid';
  const invoiceRequestable = !['pending_payment', 'cancelled', 'refunded'].includes(status);
  return {
    ...orderListItem(),
    receiver: {
      addressId: '301',
      name: '张三',
      phone: '13800138000',
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      detail: '文三路 100 号',
      postCode: null,
    },
    buyerRemark: null,
    customForm: null,
    userCouponId: null,
    paidAt: '2026-02-01T10:01:00+08:00',
    shippedAt: null,
    receivedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
    groupbuyTeamId: null,
    invoiceRequestable,
    invoiceAmount: invoiceRequestable ? '60.00' : '0.00',
    ...overrides,
  };
}

export function paged<T>(items: T[], total = items.length, page = 1, pageSize = 10) {
  return { items, total, page, pageSize };
}

export function shipment(id: string, overrides: Partial<Shipment> = {}): Shipment {
  return {
    id,
    orderId: '9001',
    shipmentNo: `SH${id}`,
    deliveryMode: 'express',
    status: 'dispatched',
    expressCompanyId: '12',
    expressCompanyName: '顺丰速运',
    trackingNo: `SF${id}`,
    courierName: null,
    courierPhone: null,
    virtualContent: null,
    remark: null,
    dispatchedAt: '2026-02-02T09:00:00+08:00',
    deliveredAt: null,
    cancelledAt: null,
    lines: [
      {
        orderItemId: '7001',
        itemKey: 'sku-7001',
        productName: '商品 7001',
        productImageUrl: '/p.jpg',
        specText: '标准装',
        quantity: 1,
      },
    ],
    ...overrides,
  };
}

export function tracking(shipmentId: string, overrides: Partial<ShipmentTracking> = {}) {
  const value: ShipmentTracking = {
    shipmentId,
    shipmentNo: `SH${shipmentId}`,
    expressCompanyName: '顺丰速运',
    trackingNo: `SF${shipmentId}`,
    available: true,
    state: 'in_transit',
    traces: [
      { at: '2026-02-02T09:30:00+08:00', context: '快件已从转运中心发出' },
      { at: '2026-02-02T09:05:00+08:00', context: '已收取快件' },
    ],
    queriedAt: '2026-02-02T12:00:00+08:00',
    ...overrides,
  };
  return value;
}

export function refundableItem(
  orderItemId: string,
  overrides: Partial<RefundableItem> = {},
): RefundableItem {
  return {
    orderItemId,
    itemKey: `sku-${orderItemId}`,
    productName: `商品 ${orderItemId}`,
    productImageUrl: '/p.jpg',
    specText: '标准装',
    quantity: 2,
    refundedQuantity: 0,
    shippedQuantity: 0,
    refundableQuantity: 2,
    unitPrice: '30.00',
    totalAmount: '60.00',
    refundableAmount: '60.00',
    blockedReason: null,
    ...overrides,
  };
}

export function refundableItems(
  overrides: Partial<RefundableItemsResult> = {},
): RefundableItemsResult {
  return {
    orderId: '9001',
    orderNo: '202602011000000010123456',
    paidAmount: '68.00',
    refundedAmount: '0.00',
    refundableAmount: '68.00',
    freightAmount: '8.00',
    freightRefundable: true,
    items: [refundableItem('7001')],
    ...overrides,
  };
}

export function refundListItem(overrides: Partial<RefundListItem> = {}): RefundListItem {
  return {
    id: '601',
    refundNo: 'RF2602261300000601',
    orderId: '9001',
    orderNo: '202602011000000010123456',
    kind: 'refund_only',
    status: 'applied',
    returnStage: 'not_required',
    quantity: 1,
    amount: '60.00',
    refundedAmount: '0.00',
    includesFreight: false,
    reason: '不想要了',
    rejectReason: null,
    isAutomatic: false,
    items: [
      {
        orderItemId: '7001',
        productName: '商品 7001',
        productImageUrl: '/p.jpg',
        specText: '标准装',
        quantity: 1,
        amount: '60.00',
      },
    ],
    createdAt: '2026-02-26T13:00:00+08:00',
    succeededAt: null,
    ...overrides,
  };
}

export function refundDetail(overrides: Partial<RefundDetail> = {}): RefundDetail {
  return {
    ...refundListItem(),
    explanation: null,
    images: [],
    returnExpressCompanyId: null,
    returnExpressCompanyName: null,
    returnTrackingNo: null,
    returnPhone: null,
    returnAddress: null,
    logs: [
      {
        toStatus: 'applied',
        message: '买家发起仅退款申请',
        createdAt: '2026-02-26T13:00:00+08:00',
      },
    ],
    ...overrides,
  };
}
