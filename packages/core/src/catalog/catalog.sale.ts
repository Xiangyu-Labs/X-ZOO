import type { DbOrTx } from '@shop/db';

// Through `order/index.ts`, which is the only door `boundaries/core-cross-domain`
// opens; the interface itself lives in `order/catalog.port.ts`.
import type { CatalogPort, SkuForSale } from '../order';
import * as repo from './catalog.repo';

/**
 * The catalog's implementation of the order domain's `CatalogPort`.
 *
 * `getSkuForSale` (in `catalog.service.ts`) is the single-variant read that
 * *refuses* anything off the shelf, which is what order creation wants. The
 * cart cannot use it: a cart holding four rows must render all four, including
 * the one whose product an operator took down an hour ago, so the shopper can
 * see why it is greyed out and remove it. So this port answers in batch and
 * reports rather than throws — `onSale` and `deleted` are fields, not
 * exceptions — and the cart or checkout decides what to do with each row.
 *
 * Both reads sit on the same repo functions, so there is one definition of
 * "on the shelf" (`status = 'on_shelf'`, not soft-deleted, variant visible) and
 * it lives here. `registerCatalogDomain()` in `index.ts` installs it.
 */
export const catalogSalePort: CatalogPort = {
  async getSkusForSale(db: DbOrTx, skuIds: readonly number[]): Promise<Map<number, SkuForSale>> {
    const out = new Map<number, SkuForSale>();
    if (skuIds.length === 0) return out;

    const skus = await repo.skusByIds(db, skuIds);
    if (skus.size === 0) return out;

    const productIds = [...new Set([...skus.values()].map((sku) => sku.productId))];
    // Deliberately the read that *includes* soft-deleted products: a cart row
    // pointing at one has to come back with `deleted: true` rather than vanish,
    // or the shopper is left with a total they cannot account for.
    const products = await repo.productsByIds(db, productIds);
    const categoryIds = await repo.categoryIdsFor(db, productIds);

    for (const sku of skus.values()) {
      const product = products.get(sku.productId);
      if (!product) continue;
      const deleted = product.deletedAt !== null;

      out.set(sku.id, {
        skuId: sku.id,
        productId: product.id,
        productName: product.name,
        productImageUrl: product.imageUrl,
        productKind: product.kind,
        onSale: !deleted && product.status === 'on_shelf' && sku.isVisible,
        deleted,
        skuCode: sku.skuCode,
        specText: sku.specText,
        specValues: sku.specValues,
        skuImageUrl: sku.imageUrl,
        unitName: product.unitName,
        barCode: sku.barCode,
        unitPrice: sku.price,
        originalUnitPrice: sku.originalPrice,
        costUnitPrice: sku.cost,
        stock: sku.stock,
        weight: sku.weight,
        volume: sku.volume,
        freightMode: product.freightMode,
        fixedFreight: product.fixedFreight,
        shippingTemplateId: product.shippingTemplateId,
        purchaseLimitMode: product.purchaseLimitMode,
        purchaseLimitQuantity: product.purchaseLimitQuantity,
        minPurchaseQuantity: product.minPurchaseQuantity,
        categoryIds: categoryIds.get(product.id) ?? [],
        customForm: product.customForm,
      });
    }
    return out;
  },
};
