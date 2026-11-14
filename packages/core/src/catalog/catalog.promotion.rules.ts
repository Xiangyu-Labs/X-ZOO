import type { AdminProductDetail } from '@shop/contracts/catalog/schemas';
import type { ProductPromotionSettings } from '@shop/contracts/catalog/promotion';
import type { PresaleActivityDetail } from '@shop/contracts/presale/schemas';
import type { GroupbuyActivityDetail } from '@shop/contracts/groupbuy/schemas';
import { PER_ORDER_UNLIMITED } from '@shop/contracts/catalog/per-order';
import { comboKey } from './catalog.rules';
import { Money } from '../kernel/money';
import { DomainError } from '../kernel/errors';

/** Shared defaults for the two campaign adapters. All amounts remain decimal strings. */
export function productPromotionForm(
  product: AdminProductDetail,
  settings: ProductPromotionSettings,
  previous: PresaleActivityDetail | GroupbuyActivityDetail | null,
  now: Date,
) {
  const owned = new Map(product.skus.map((sku) => [comboKey(sku.specValues), sku]));
  const old = new Map(previous?.skus.map((sku) => [sku.skuId, sku]) ?? []);
  const skus = settings.skus.map((input) => {
    const sku = owned.get(comboKey(input.specValues));
    if (!sku) throw new DomainError('CATALOG_PROMOTION_INVALID');
    const prior = old.get(sku.id);
    return {
      skuId: sku.id,
      price: input.price,
      stock: input.stock ?? prior?.stock ?? sku.stock,
      expectedStock: input.expectedStock ?? prior?.stock,
      quota: input.quota === undefined ? (prior?.quota ?? undefined) : (input.quota ?? undefined),
      isEnabled: input.isEnabled ?? prior?.isEnabled ?? true,
    };
  });
  // A historical SKU with orders cannot be removed from its activity, only disabled.
  for (const prior of previous?.skus ?? []) {
    if (!skus.some((sku) => sku.skuId === prior.skuId)) {
      skus.push({
        ...prior,
        expectedStock: prior.stock,
        quota: prior.quota ?? undefined,
        isEnabled: false,
      });
    }
  }
  const enabled = skus.filter((sku) => sku.isEnabled);
  if (enabled.length === 0) throw new DomainError('CATALOG_PROMOTION_INVALID');
  const price = enabled
    .map((sku) => Money.parse(sku.price))
    .reduce(Money.min)
    .toString();
  return {
    productId: product.id,
    title: settings.title ?? previous?.title ?? product.name,
    intro:
      settings.intro === undefined ? (previous?.intro ?? undefined) : (settings.intro ?? undefined),
    imageUrl:
      settings.imageUrl === undefined
        ? previous
          ? (previous.imageUrl ?? undefined)
          : product.imageUrl
        : (settings.imageUrl ?? undefined),
    sliderImages: settings.sliderImages ?? previous?.sliderImages ?? product.sliderImages,
    status:
      settings.status ?? (previous?.status === 'ended' ? 'active' : previous?.status) ?? 'active',
    price,
    originalPrice:
      settings.originalPrice === undefined
        ? previous
          ? (previous.originalPrice ?? undefined)
          : product.price
        : (settings.originalPrice ?? undefined),
    stock: settings.stock ?? previous?.stock ?? enabled.reduce((sum, sku) => sum + sku.stock, 0),
    expectedStock: settings.expectedStock ?? previous?.stock,
    totalQuota:
      settings.totalQuota === undefined
        ? (previous?.totalQuota ?? undefined)
        : (settings.totalQuota ?? undefined),
    perOrderQuantity:
      settings.perOrderQuantity === null
        ? PER_ORDER_UNLIMITED
        : (settings.perOrderQuantity ?? previous?.perOrderQuantity ?? PER_ORDER_UNLIMITED),
    startAt:
      settings.startAt === null
        ? now.toISOString()
        : (settings.startAt ?? previous?.startAt ?? now.toISOString()),
    endAt: settings.endAt,
    shippingTemplateId:
      settings.shippingTemplateId === undefined
        ? (previous?.shippingTemplateId ?? undefined)
        : (settings.shippingTemplateId ?? undefined),
    sortOrder: settings.sortOrder ?? previous?.sortOrder ?? 0,
    skus,
  };
}
