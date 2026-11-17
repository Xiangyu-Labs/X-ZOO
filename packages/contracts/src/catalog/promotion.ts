import { z } from 'zod';
import {
  id,
  idList,
  instant,
  money,
  paged,
  pageQuery,
  requiredMoney,
} from '../_conventions/common';
import { PER_ORDER_UNLIMITED } from './per-order';

export const productSaleMode = z.enum(['normal', 'presale', 'groupbuy', 'flashsale']);
/** `flashsale` is 限时秒杀: a per-SKU price inside a window, bought through ordinary checkout. */
export const productPromotionKind = z.enum(['presale', 'groupbuy', 'flashsale']);

/** Spec values also address new editor rows which have no persisted SKU id yet. */
export const productPromotionSkuInput = z.object({
  specValues: z
    .record(z.string().max(64), z.string().max(64))
    .refine((values) => Object.keys(values).length <= 5, '规格最多 5 项'),
  price: requiredMoney('请填写活动价格'),
  stock: z.number().int().min(0).max(1_000_000).optional(),
  expectedStock: z.number().int().min(0).optional(),
  quota: z.number().int().min(0).max(1_000_000).nullable().optional(),
  isEnabled: z.boolean().optional(),
});

/** Omitted advanced fields preserve existing activity values. Explicit null clears them. */
export const productPromotionSettings = z.object({
  endAt: z.string().min(1, '请选择活动结束时间').pipe(instant),
  shipAfterDays: z.number().int().min(0).max(365).optional(),
  seatsRequired: z.number().int().min(2).max(100).optional(),
  skus: z.array(productPromotionSkuInput).min(1).max(200),
  title: z.string().trim().min(1).max(255).optional(),
  originalPrice: money.nullable().optional(),
  cost: money.nullable().optional(),
  intro: z.string().max(255).nullable().optional(),
  imageUrl: z.string().max(512).nullable().optional(),
  sliderImages: z.array(z.string().max(512)).max(10).optional(),
  startAt: instant.nullable().optional(),
  status: z.enum(['draft', 'active', 'paused']).optional(),
  stock: z.number().int().min(0).max(1_000_000).optional(),
  expectedStock: z.number().int().min(0).optional(),
  totalQuota: z.number().int().min(0).max(1_000_000).nullable().optional(),
  /** `null` is 不限 (stored as {@link PER_ORDER_UNLIMITED}); absent keeps what is saved. */
  perOrderQuantity: z.number().int().min(1).max(PER_ORDER_UNLIMITED).nullable().optional(),
  groupTtlSeconds: z
    .number()
    .int()
    .min(60)
    .max(30 * 86400)
    .optional(),
  shippingTemplateId: id.nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});
export type ProductPromotionSettings = z.infer<typeof productPromotionSettings>;

export const productPromotionInput = z
  .object({
    mode: productSaleMode,
    expectedVersion: z.number().int().min(0),
    activityId: id.optional(),
    settings: productPromotionSettings.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'normal') return;
    if (!value.settings) {
      ctx.addIssue({ code: 'custom', path: ['settings'], message: '请填写活动设置' });
      return;
    }
    if (value.mode === 'presale' && value.settings.shipAfterDays === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['settings', 'shipAfterDays'],
        message: '请填写付款后发货天数',
      });
    }
    if (value.mode === 'groupbuy' && value.settings.seatsRequired === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['settings', 'seatsRequired'],
        message: '请填写成团人数',
      });
    }
    if (value.mode === 'flashsale' && !value.settings.startAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['settings', 'startAt'],
        message: '请选择秒杀开始时间',
      });
    }
    if (
      value.settings.startAt &&
      Date.parse(value.settings.endAt) <= Date.parse(value.settings.startAt)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['settings', 'endAt'],
        message: '结束时间必须晚于开始时间',
      });
    }
  });
export type ProductPromotionInput = z.infer<typeof productPromotionInput>;

export const productPromotionCandidate = z.object({
  kind: productPromotionKind,
  activityId: id,
  title: z.string(),
  status: z.enum(['draft', 'active', 'paused', 'ended']),
  settings: productPromotionSettings
    .extend({ skus: z.array(productPromotionSkuInput).max(200) })
    .optional(),
});
export type ProductPromotionCandidate = z.infer<typeof productPromotionCandidate>;
export const productPromotionAdmin = z.object({
  version: z.number().int().min(0),
  mode: productSaleMode,
  activityId: id.nullable(),
  conflict: z.boolean(),
  candidates: z.array(productPromotionCandidate),
});
export type ProductPromotionAdmin = z.infer<typeof productPromotionAdmin>;

export const storefrontPromotion = z.object({
  kind: productPromotionKind,
  activityId: id,
  price: money,
  originalPrice: money.nullable(),
  endAt: instant,
  canBuy: z.boolean(),
  seatsRequired: z.number().int().min(2).nullable(),
  shipAfterDays: z.number().int().min(0).nullable(),
  perOrderQuantity: z.number().int().min(1),
  skus: z.array(
    z.object({
      skuId: id,
      specText: z.string(),
      specValues: z.record(z.string(), z.string()),
      imageUrl: z.string().nullable(),
      price: money,
      originalPrice: money.nullable(),
      stock: z.number().int().min(0),
    }),
  ),
});
export type StorefrontPromotion = z.infer<typeof storefrontPromotion>;

/**
 * One 限时秒杀 as the storefront lists it (the 秒杀 list page, a DIY 限时秒杀
 * block): a product whose current campaign is an active flash sale inside its
 * window `[startAt, endAt)`, on the shelf. `price` is the lowest 秒杀价 that
 * applies now (one that undercuts its SKU's own price, as checkout charges it);
 * `originalPrice` is that SKU's own price, struck through beside it. `stock` is
 * the product's, summed over the SKUs on 秒杀: a flash sale has no stock of its own.
 */
export const flashSaleCard = z.object({
  activityId: id,
  productId: id,
  title: z.string(),
  imageUrl: z.string().nullable(),
  price: money,
  originalPrice: money.nullable(),
  stock: z.number().int().min(0),
  startAt: instant,
  endAt: instant,
  canBuy: z.boolean(),
});
export type FlashSaleCard = z.infer<typeof flashSaleCard>;

export const flashSaleListQuery = pageQuery.extend({
  /**
   * Exactly these products' flash sales, in this order — what a DIY 限时秒杀
   * block's 手动选择 saved. Products, not campaigns: a product saved again after
   * its window gets a new campaign row, and the pick should follow it. A product
   * not on 秒杀 (no campaign, outside its window, off the shelf) is skipped,
   * not an error.
   */
  productIds: idList.optional(),
  /**
   * Also the 秒杀 that have not started yet (即将开始), after the live ones and
   * soonest-starting first. Their card carries the 秒杀价 as it will be at the
   * start; `startAt` in the future tells the client it is not on yet.
   */
  upcoming: z.stringbool().optional(),
});
export type FlashSaleListQuery = z.infer<typeof flashSaleListQuery>;
export const pagedFlashSaleCards = paged(flashSaleCard);

export const flashSaleCardExample: FlashSaleCard = {
  activityId: '5',
  productId: '12',
  title: '经典白T恤',
  imageUrl: 'https://cdn.example.com/p/12.jpg',
  price: '59.00',
  originalPrice: '99.00',
  stock: 120,
  startAt: '2026-11-17T10:00:00+08:00',
  endAt: '2026-11-20T23:59:59+08:00',
  canBuy: true,
};
