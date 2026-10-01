import { z } from 'zod';
import { id, idList, instant, money, pageQuery, paged, sortQuery } from '../_conventions/common';

/**
 * Shapes shared by the presale routes.
 *
 * The enums mirror the PostgreSQL enums of `db/src/schema/presale.ts` and are
 * kept honest by `presale.service.ts` assigning one to the other.
 *
 * **Full payment only.** `paymentMode` and `stage` carry the deposit vocabulary
 * because the columns exist (SCHEMA.md §6.3), but no route drives a deposit: an
 * activity saved with `paymentMode: 'deposit'` is refused with
 * `PRESALE_DEPOSIT_NOT_SUPPORTED`, and every presale order goes
 * `final_pending → final_paid`.
 */

// ---------------------------------------------------------------------------
// enums
// ---------------------------------------------------------------------------

export const presaleActivityStatus = z.enum(['draft', 'active', 'paused', 'ended']);
export type PresaleActivityStatus = z.infer<typeof presaleActivityStatus>;

export const presalePaymentMode = z.enum(['full', 'deposit']);
export type PresalePaymentMode = z.infer<typeof presalePaymentMode>;

export const presaleOrderStage = z.enum([
  'deposit_pending',
  'deposit_paid',
  'final_pending',
  'final_paid',
  'expired',
  'cancelled',
]);
export type PresaleOrderStage = z.infer<typeof presaleOrderStage>;

// ---------------------------------------------------------------------------
// admin: activities
// ---------------------------------------------------------------------------

export const presaleActivitySku = z.object({
  skuId: id,
  specText: z.string(),
  price: money,
  stock: z.number().int().min(0),
  sales: z.number().int().min(0),
  quota: z.number().int().min(0).nullable(),
  isEnabled: z.boolean(),
});
export type PresaleActivitySku = z.infer<typeof presaleActivitySku>;

export const presaleActivitySkuInput = z.object({
  skuId: id,
  price: money,
  stock: z.number().int().min(0).max(1_000_000),
  /** The stock the form loaded with; see `expectedStock` on the product SKU input. */
  expectedStock: z.number().int().min(0).optional(),
  quota: z.number().int().min(0).max(1_000_000).optional(),
  isEnabled: z.boolean().default(true),
});
export type PresaleActivitySkuInput = z.infer<typeof presaleActivitySkuInput>;

export const presaleActivityListItem = z.object({
  id,
  productId: id,
  productName: z.string(),
  title: z.string(),
  intro: z.string().nullable(),
  imageUrl: z.string().nullable(),
  status: presaleActivityStatus,
  paymentMode: presalePaymentMode,
  price: money,
  originalPrice: money.nullable(),
  stock: z.number().int().min(0),
  sales: z.number().int().min(0),
  totalQuota: z.number().int().min(0).nullable(),
  perOrderQuantity: z.number().int().min(1),
  startAt: instant,
  endAt: instant,
  /** 预售发货：付款后 N 天内发货. */
  shipAfterDays: z.number().int().min(0),
  sortOrder: z.number().int(),
  createdAt: instant,
});
export type PresaleActivityListItem = z.infer<typeof presaleActivityListItem>;

export const presaleActivityDetail = presaleActivityListItem.extend({
  sliderImages: z.array(z.string()),
  shippingTemplateId: id.nullable(),
  skus: z.array(presaleActivitySku),
});
export type PresaleActivityDetail = z.infer<typeof presaleActivityDetail>;

export const presaleActivityForm = z
  .object({
    productId: id,
    title: z.string().min(1).max(255),
    intro: z.string().max(255).optional(),
    imageUrl: z.string().max(512).optional(),
    sliderImages: z.array(z.string().max(512)).max(10).default([]),
    status: presaleActivityStatus.default('draft'),
    /** Only `full` is accepted; `deposit` is refused by the service. */
    paymentMode: presalePaymentMode.default('full'),
    price: money,
    originalPrice: money.optional(),
    stock: z.number().int().min(0).max(1_000_000),
    /**
     * The stock the form loaded with. Unchanged, the live number is kept;
     * changed while orders moved it, the save is refused with `*_STOCK_CHANGED`.
     */
    expectedStock: z.number().int().min(0).optional(),
    totalQuota: z.number().int().min(0).max(1_000_000).optional(),
    perOrderQuantity: z.number().int().min(1).max(999).default(1),
    startAt: instant,
    endAt: instant,
    shipAfterDays: z.number().int().min(0).max(365).default(0),
    shippingTemplateId: id.optional(),
    sortOrder: z.number().int().min(0).max(9999).default(0),
    skus: z.array(presaleActivitySkuInput).max(200).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.endAt <= value.startAt) {
      ctx.addIssue({ code: 'custom', path: ['endAt'], message: '结束时间必须晚于开始时间' });
    }
    if (value.paymentMode === 'deposit') {
      ctx.addIssue({ code: 'custom', path: ['paymentMode'], message: '暂不支持定金预售' });
    }
    const seen = new Set<string>();
    for (const [index, sku] of value.skus.entries()) {
      if (seen.has(sku.skuId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['skus', index, 'skuId'],
          message: '同一规格只能配置一次',
        });
      }
      seen.add(sku.skuId);
    }
  });
export type PresaleActivityForm = z.infer<typeof presaleActivityForm>;

export const presaleActivityListQuery = pageQuery
  .extend({
    keyword: z.string().trim().max(64).optional(),
    status: z.union([presaleActivityStatus, z.array(presaleActivityStatus)]).optional(),
    productId: id.optional(),
  })
  .extend(sortQuery(['id', 'sortOrder', 'sales', 'startAt', 'createdAt']).shape);
export type PresaleActivityListQuery = z.infer<typeof presaleActivityListQuery>;

export const pagedPresaleActivities = paged(presaleActivityListItem);

export const presaleActivityStatusBody = z.object({
  status: z.enum(['active', 'paused']),
});
export type PresaleActivityStatusBody = z.infer<typeof presaleActivityStatusBody>;

// ---------------------------------------------------------------------------
// admin: orders
// ---------------------------------------------------------------------------

/** One presale order, as 预售订单 shows it. */
export const presaleOrderItem = z.object({
  orderId: id,
  orderNo: z.string(),
  activityId: id,
  activityTitle: z.string(),
  userId: id,
  nickname: z.string().nullable(),
  paymentMode: presalePaymentMode,
  stage: presaleOrderStage,
  quantity: z.number().int().min(1),
  payableAmount: money,
  finalAmount: money.nullable(),
  finalPaidAt: instant.nullable(),
  finalDueAt: instant.nullable(),
  /** Earliest ship date, `paidAt + shipAfterDays`. `null` until the order is paid. */
  shipNotBeforeAt: instant.nullable(),
  createdAt: instant,
});
export type PresaleOrderItem = z.infer<typeof presaleOrderItem>;

export const presaleOrderListQuery = pageQuery
  .extend({
    activityId: id.optional(),
    stage: z.union([presaleOrderStage, z.array(presaleOrderStage)]).optional(),
    userId: id.optional(),
  })
  .extend(sortQuery(['orderId', 'createdAt', 'shipNotBeforeAt']).shape);
export type PresaleOrderListQuery = z.infer<typeof presaleOrderListQuery>;

export const pagedPresaleOrders = paged(presaleOrderItem);

// ---------------------------------------------------------------------------
// storefront
// ---------------------------------------------------------------------------

export const presaleCard = z.object({
  activityId: id,
  productId: id,
  title: z.string(),
  intro: z.string().nullable(),
  imageUrl: z.string().nullable(),
  price: money,
  originalPrice: money.nullable(),
  stock: z.number().int().min(0),
  sales: z.number().int().min(0),
  startAt: instant,
  endAt: instant,
  shipAfterDays: z.number().int().min(0),
  canBuy: z.boolean(),
});
export type PresaleCard = z.infer<typeof presaleCard>;

export const presaleListQuery = pageQuery.extend({
  /**
   * Only this product's activities — what 商品详情 asks to learn whether a product is on
   * 预售 right now. The list's own rule still holds: `active` and inside its window.
   */
  productId: id.optional(),
  /**
   * Exactly these activities, in this order — what a DIY 预售 component's
   * 指定数据 saved. An activity the shopper cannot see now (paused, outside its
   * window, deleted) is skipped, not an error. With `productId` as well, the
   * intersection: the picked activities that are that product's, still in the
   * picked order.
   */
  ids: idList.optional(),
});
export type PresaleListQuery = z.infer<typeof presaleListQuery>;
export const pagedPresaleCards = paged(presaleCard);

export const presaleStorefrontSku = z.object({
  skuId: id,
  specText: z.string(),
  specValues: z.record(z.string(), z.string()),
  imageUrl: z.string().nullable(),
  price: money,
  originalPrice: money.nullable(),
  stock: z.number().int().min(0),
});
export type PresaleStorefrontSku = z.infer<typeof presaleStorefrontSku>;

export const presaleDetail = presaleCard.extend({
  sliderImages: z.array(z.string()),
  perOrderQuantity: z.number().int().min(1),
  description: z.string().nullable(),
  skus: z.array(presaleStorefrontSku),
});
export type PresaleDetail = z.infer<typeof presaleDetail>;

// ---------------------------------------------------------------------------
// examples
// ---------------------------------------------------------------------------

/**
 * One coherent fixture: activity 2 (冬季新茶 · 预售, 预售价 128.00 against
 * 168.00, 付款后 15 天内发货), order 7101 placed by 小红 and already paid.
 */
export const presaleActivityExample: PresaleActivityListItem = {
  id: '2',
  productId: '12',
  productName: '明前龙井 2027 春茶',
  title: '春茶预售 · 明前龙井',
  intro: '付款后 15 天内发货',
  imageUrl: 'https://cdn.example.com/p/12.jpg',
  status: 'active',
  paymentMode: 'full',
  price: '128.00',
  originalPrice: '168.00',
  stock: 500,
  sales: 87,
  totalQuota: 1000,
  perOrderQuantity: 5,
  startAt: '2026-09-01T00:00:00+08:00',
  endAt: '2026-11-30T23:59:59+08:00',
  shipAfterDays: 15,
  sortOrder: 0,
  createdAt: '2026-08-20T10:00:00+08:00',
};

export const presaleActivitySkuExample: PresaleActivitySku = {
  skuId: '31',
  specText: '特级|250g',
  price: '128.00',
  stock: 500,
  sales: 87,
  quota: 1000,
  isEnabled: true,
};

export const presaleActivityDetailExample: PresaleActivityDetail = {
  ...presaleActivityExample,
  sliderImages: ['https://cdn.example.com/p/12-1.jpg'],
  shippingTemplateId: null,
  skus: [presaleActivitySkuExample],
};

export const presaleOrderExample: PresaleOrderItem = {
  orderId: '7101',
  orderNo: '202609221100000000000001',
  activityId: '2',
  activityTitle: '春茶预售 · 明前龙井',
  userId: '102',
  nickname: '小红',
  paymentMode: 'full',
  stage: 'final_paid',
  quantity: 1,
  payableAmount: '128.00',
  finalAmount: '128.00',
  finalPaidAt: '2026-09-22T11:05:00+08:00',
  finalDueAt: '2026-09-22T11:30:00+08:00',
  shipNotBeforeAt: '2026-10-07T11:05:00+08:00',
  createdAt: '2026-09-22T11:00:00+08:00',
};

export const presaleCardExample: PresaleCard = {
  activityId: '2',
  productId: '12',
  title: '春茶预售 · 明前龙井',
  intro: '付款后 15 天内发货',
  imageUrl: 'https://cdn.example.com/p/12.jpg',
  price: '128.00',
  originalPrice: '168.00',
  stock: 500,
  sales: 87,
  startAt: '2026-09-01T00:00:00+08:00',
  endAt: '2026-11-30T23:59:59+08:00',
  shipAfterDays: 15,
  canBuy: true,
};

export const presaleDetailExample: PresaleDetail = {
  ...presaleCardExample,
  sliderImages: ['https://cdn.example.com/p/12-1.jpg'],
  perOrderQuantity: 5,
  description: '<p>明前采摘，付款后 15 天内发货。</p>',
  skus: [
    {
      skuId: '31',
      specText: '特级|250g',
      specValues: { 等级: '特级', 规格: '250g' },
      imageUrl: 'https://cdn.example.com/sku/31.jpg',
      price: '128.00',
      originalPrice: '168.00',
      stock: 500,
    },
  ],
};
