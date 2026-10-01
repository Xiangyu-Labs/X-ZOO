import type { ResponseOf } from '@shop/api-client';

type Preview = ResponseOf<'order.checkoutPreview'>;
type Order = ResponseOf<'order.detail'>;
type Applicable = ResponseOf<'coupon.applicableList'>;

export const receiverFixture = {
  addressId: '301',
  name: '林小姐',
  phone: '13800138000',
  province: '浙江省',
  city: '杭州市',
  district: '西湖区',
  detail: '文三路 100 号',
  postCode: null,
};

/** One line, 柔雾丝绒礼盒 黑 / M × 2, to the default address, 8.00 freight. */
export function previewFixture(overrides: Partial<Preview> = {}): Preview {
  return {
    lines: [
      {
        itemKey: 'sku-103',
        productId: '12',
        skuId: '103',
        cartItemId: null,
        productName: '柔雾丝绒礼盒',
        productImageUrl: '/uploads/p12.jpg',
        productKind: 'physical',
        skuImageUrl: null,
        specText: '黑|M',
        unitName: '盒',
        quantity: 2,
        unitPrice: '59.00',
        originalUnitPrice: null,
        subtotal: '118.00',
        discountAmount: '0.00',
        totalAmount: '118.00',
      },
    ],
    receiver: receiverFixture,
    addressRequired: true,
    totalQuantity: 2,
    itemsAmount: '118.00',
    freightAmount: '8.00',
    couponDiscount: '0.00',
    adjustments: [],
    payableAmount: '126.00',
    userCouponId: null,
    payWindowMinutes: 30,
    shipAfterDays: null,
    customFormFields: [],
    ...overrides,
  };
}

/** The same order priced with 满100减10 (`901`). */
export function previewWithCoupon(): Preview {
  return previewFixture({
    couponDiscount: '10.00',
    adjustments: [{ source: 'coupon:full-reduction', label: '满100减10', amount: '-10.00' }],
    payableAmount: '116.00',
    userCouponId: '901',
  });
}

export function userCouponFixture(id: string, minSpend: string, discountAmount: string) {
  return {
    id,
    templateId: `8${id}`,
    title: `满${Number(minSpend)}减${Number(discountAmount)}`,
    discountAmount,
    minSpend,
    scope: 'all_products' as const,
    status: 'unused' as const,
    sourceKind: 'claim' as const,
    validFrom: '2026-09-01T00:00:00+08:00',
    validTo: '2026-12-31T23:59:59+08:00',
    usedAt: null,
    createdAt: '2026-09-01T00:00:00+08:00',
  };
}

/** 满100减10 usable, 满200减30 not. */
export function applicableFixture(): Applicable {
  return {
    subtotal: '118.00',
    items: [
      {
        coupon: userCouponFixture('901', '100.00', '10.00'),
        usable: true,
        discount: '10.00',
        eligibleLineIndexes: [0],
        reason: null,
      },
      {
        coupon: userCouponFixture('902', '200.00', '30.00'),
        usable: false,
        discount: '0.00',
        eligibleLineIndexes: [0],
        reason: 'COUPON_MIN_SPEND_NOT_MET',
      },
    ],
  };
}

export function orderFixture(overrides: Partial<Order> = {}): Order {
  return {
    id: '9',
    orderNo: '202609230000000000000009',
    kind: 'normal',
    status: 'pending_payment',
    fulfillmentStatus: 'unfulfilled',
    refundStatus: 'none',
    totalQuantity: 2,
    itemsAmount: '118.00',
    freightAmount: '8.00',
    couponDiscount: '10.00',
    payableAmount: '116.00',
    paidAmount: null,
    payExpiresAt: '2099-01-01T00:00:00+08:00',
    createdAt: '2026-09-23T10:00:00+08:00',
    items: [
      {
        id: '7001',
        itemKey: 'sku-103',
        productId: '12',
        skuId: '103',
        productName: '柔雾丝绒礼盒',
        productImageUrl: '/uploads/p12.jpg',
        productKind: 'physical',
        specText: '黑|M',
        skuImageUrl: null,
        unitName: '盒',
        quantity: 2,
        unitPrice: '59.00',
        originalUnitPrice: null,
        discountAmount: '10.00',
        totalAmount: '108.00',
        refundedQuantity: 0,
        shippedQuantity: 0,
        adjustments: [],
        reviewed: false,
        reviewable: false,
      },
    ],
    receiver: receiverFixture,
    buyerRemark: null,
    customForm: null,
    userCouponId: '901',
    paidAt: null,
    shippedAt: null,
    receivedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
    groupbuyTeamId: null,
    refundedAmount: '0.00',
    hasOpenRefund: false,
    groupbuyTeam: null,
    invoiceRequestable: false,
    invoiceAmount: '0.00',
    ...overrides,
  };
}
