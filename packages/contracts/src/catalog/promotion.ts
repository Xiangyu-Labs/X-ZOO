import { z } from 'zod';
import { id, instant, money, requiredMoney } from '../_conventions/common';
import { PER_ORDER_UNLIMITED } from './per-order';

export const productSaleMode = z.enum(['normal', 'presale', 'groupbuy']);
export const productPromotionKind = z.enum(['presale', 'groupbuy']);

/** Spec values also address new editor rows which have no persisted SKU id yet. */
export const productPromotionSkuInput = z.object({
  specValues: z.record(z.string(), z.string()),
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
