import { DomainError } from '../kernel/errors';
import { toId, toIdOrNull } from '../kernel/ids';
import { presaleActivityForm } from '@shop/contracts/presale/schemas';
import {
  registerProductPromotionPort,
  productPromotionForm,
  type ProductPromotionPort,
} from '../catalog';
import { canBuy } from './presale.rules';
import * as service from './presale.service';
import * as repo from './presale.repo';

const STOREFRONT_READABLE: ReadonlySet<repo.ActivityRow['status']> = new Set([
  'active',
  'paused',
  'ended',
]);

const port: ProductPromotionPort = {
  async candidates(ctx, productId, includeId) {
    const activities = await repo.listProductActivities(ctx.db, productId, includeId);
    if (activities.length === 0) return [];

    const skus = await repo.listActivitySkus(
      ctx.db,
      activities.map((activity) => activity.id),
    );
    const skusByActivity = new Map<number, repo.ActivitySkuRow[]>();
    for (const sku of skus) {
      const list = skusByActivity.get(sku.activityId);
      if (list) list.push(sku);
      else skusByActivity.set(sku.activityId, [sku]);
    }

    return activities.map((activity) => ({
      kind: 'presale' as const,
      activityId: String(activity.id),
      title: activity.title,
      status: activity.status,
      settings: {
        endAt: activity.endAt.toISOString(),
        startAt: activity.startAt.toISOString(),
        shipAfterDays: activity.shipAfterDays,
        title: activity.title,
        originalPrice: activity.originalPrice,
        intro: activity.intro,
        imageUrl: activity.imageUrl,
        sliderImages: activity.sliderImages,
        ...(activity.status === 'ended' ? {} : { status: activity.status }),
        stock: activity.stock,
        expectedStock: activity.stock,
        totalQuota: activity.totalQuota,
        perOrderQuantity: activity.perOrderQuantity,
        shippingTemplateId: toIdOrNull(activity.shippingTemplateId),
        sortOrder: activity.sortOrder,
        skus: (skusByActivity.get(activity.id) ?? []).map((sku) => ({
          specValues: sku.specValues,
          price: sku.price,
          stock: sku.stock,
          expectedStock: sku.stock,
          quota: sku.quota,
          isEnabled: sku.isEnabled,
        })),
      },
    }));
  },
  async summaries(ctx, productIds, includeIds) {
    return (await repo.productActivitySummaries(ctx.db, productIds, includeIds)).map((row) => ({
      ...row,
      activityId: String(row.id),
    }));
  },
  async save(ctx, { product, settings, activityId }) {
    const previous = activityId ? await service.adminActivityDetail(ctx, { id: activityId }) : null;
    const parsed = presaleActivityForm.safeParse({
      ...productPromotionForm(product, settings, previous, ctx.clock.now()),
      shipAfterDays: settings.shipAfterDays ?? previous?.shipAfterDays ?? 0,
      paymentMode: 'full',
    });
    if (!parsed.success) throw new DomainError('CATALOG_PROMOTION_INVALID');
    const body = parsed.data;
    const saved = activityId
      ? await service.adminActivityUpdate(ctx, { id: activityId }, body)
      : await service.adminActivityCreate(ctx, body);
    return saved.id;
  },
  async end(ctx, activityId) {
    await ctx.withTx(async (tx) => {
      await repo.endProductActivity(tx, Number(activityId), ctx.clock.now());
    });
  },
  async storefront(ctx, activityId) {
    const id = Number(activityId);
    const now = ctx.clock.now();
    const [activity, skus] = await Promise.all([
      repo.findActivity(ctx.db, id, { sellableProductOnly: true }),
      repo.listActivitySkus(ctx.db, [id]),
    ]);
    if (!activity || !STOREFRONT_READABLE.has(activity.status)) {
      throw new DomainError('PRESALE_ACTIVITY_NOT_FOUND');
    }

    return {
      kind: 'presale',
      activityId,
      price: activity.price,
      originalPrice: activity.originalPrice,
      endAt: activity.endAt.toISOString(),
      canBuy: canBuy(activity, now),
      seatsRequired: null,
      shipAfterDays: activity.shipAfterDays,
      perOrderQuantity: activity.perOrderQuantity,
      skus: skus
        .filter((sku) => sku.isEnabled)
        .map((sku) => ({
          skuId: toId(sku.skuId),
          specText: sku.specText,
          specValues: sku.specValues,
          imageUrl: sku.imageUrl,
          price: sku.price,
          originalPrice: sku.skuOriginalPrice ?? sku.skuPrice,
          stock: sku.stock,
        })),
    };
  },
};
export function registerPresaleProductPromotion(): void {
  registerProductPromotionPort('presale', port);
}
