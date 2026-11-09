import { DomainError } from '../kernel/errors';
import { presaleActivityForm } from '@shop/contracts/presale/schemas';
import {
  registerProductPromotionPort,
  productPromotionForm,
  type ProductPromotionPort,
} from '../catalog';
import * as service from './presale.service';
import * as repo from './presale.repo';

const port: ProductPromotionPort = {
  async candidates(ctx, productId, includeId) {
    const ids = await repo.productActivityIds(ctx.db, productId, includeId);
    const out = [];
    for (const id of ids) {
      const activity = await service.adminActivityDetail(ctx, { id: String(id) });
      const skus = await repo.listActivitySkus(ctx.db, [id]);
      out.push({
        kind: 'presale' as const,
        activityId: String(id),
        title: activity.title,
        status: activity.status,
        settings: {
          endAt: activity.endAt,
          startAt: activity.startAt,
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
          shippingTemplateId: activity.shippingTemplateId,
          sortOrder: activity.sortOrder,
          skus: skus.map((sku) => ({
            specValues: sku.specValues,
            price: sku.price,
            stock: sku.stock,
            expectedStock: sku.stock,
            quota: sku.quota,
            isEnabled: sku.isEnabled,
          })),
        },
      });
    }
    return out;
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
    const data = await service.detail(ctx, { id: activityId });
    return {
      kind: 'presale',
      activityId,
      price: data.price,
      originalPrice: data.originalPrice,
      endAt: data.endAt,
      canBuy: data.canBuy,
      seatsRequired: null,
      shipAfterDays: data.shipAfterDays,
      perOrderQuantity: data.perOrderQuantity,
      skus: data.skus,
    };
  },
};
export function registerPresaleProductPromotion(): void {
  registerProductPromotionPort('presale', port);
}
