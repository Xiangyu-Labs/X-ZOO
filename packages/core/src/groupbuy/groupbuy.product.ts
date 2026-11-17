import { hasPermission } from '../auth';
import {
  registerProductPromotionPort,
  productPromotionForm,
  type ProductPromotionPort,
} from '../catalog';
import { DomainError } from '../kernel/errors';
import { toIdOrNull } from '../kernel/ids';
import { groupbuyActivityForm } from '@shop/contracts/groupbuy/schemas';
import { groupbuyPermissions } from './permissions';
import * as service from './groupbuy.service';
import * as repo from './groupbuy.repo';

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
    const canWriteCost = hasPermission(ctx.actor, groupbuyPermissions['activity:write']);

    return activities.map((activity) => ({
      kind: 'groupbuy' as const,
      activityId: String(activity.id),
      title: activity.title,
      status: activity.status,
      settings: {
        endAt: activity.endAt.toISOString(),
        startAt: activity.startAt.toISOString(),
        seatsRequired: activity.seatsRequired,
        groupTtlSeconds: activity.groupTtlSeconds,
        title: activity.title,
        originalPrice: activity.originalPrice,
        cost: canWriteCost ? activity.cost : null,
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
    const parsed = groupbuyActivityForm.safeParse({
      ...productPromotionForm(product, settings, previous, ctx.clock.now()),
      seatsRequired: settings.seatsRequired ?? previous?.seatsRequired ?? 2,
      groupTtlSeconds: settings.groupTtlSeconds ?? previous?.groupTtlSeconds ?? 86400,
      cost:
        settings.cost === undefined ? (previous?.cost ?? undefined) : (settings.cost ?? undefined),
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
    // The campaign and its SKUs only: `service.detail()` would also read the
    // description, the forming teams and the shopper's own team, and count a
    // view of a campaign page nobody opened.
    const id = Number(activityId);
    const [activity, skus] = await Promise.all([
      repo.findActivity(ctx.db, id, { sellableProductOnly: true }),
      repo.listActivitySkus(ctx.db, [id]),
    ]);
    if (!activity) throw new DomainError('GROUPBUY_ACTIVITY_NOT_FOUND');
    return {
      kind: 'groupbuy',
      activityId,
      price: activity.price,
      originalPrice: activity.originalPrice,
      endAt: activity.endAt.toISOString(),
      canBuy: service.canJoin(activity, ctx.clock.now()),
      seatsRequired: activity.seatsRequired,
      shipAfterDays: null,
      perOrderQuantity: activity.perOrderQuantity,
      skus: service.toStorefrontSkus(skus),
    };
  },
};
export function registerGroupbuyProductPromotion(): void {
  registerProductPromotionPort('groupbuy', port);
}
