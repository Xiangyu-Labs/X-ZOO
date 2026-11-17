import type { DbOrTx } from '@shop/db';
import { PER_ORDER_UNLIMITED } from '@shop/contracts/catalog/per-order';
import type { ProductPromotionCandidate } from '@shop/contracts/catalog/promotion';
import { DomainError } from '../kernel/errors';
import { Money } from '../kernel/money';
import { registerProductPromotionPort, type ProductPromotionPort } from './catalog.promotion';
import { comboKey } from './catalog.rules';
import * as repo from './catalog.flashsale.repo';
import * as catalogRepo from './catalog.repo';

/**
 * 限时秒杀 (#97, PROMO-004): the third product sale mode, beside 预售 and 拼团.
 *
 * Unlike those two it has no order kind, no stock of its own and no quota: a
 * flash sale is a per-SKU 秒杀价 that ordinary checkout charges while the window
 * `[startAt, endAt)` holds (`flashSalePrices`, read by `catalog.sale.ts`). So the
 * order, its stock reservation, the sales counter and every inverse — cancel,
 * close, refund — are the ordinary ones, and restore exactly what they took.
 *
 * Exclusivity, stale-editor protection and the terminal `ended` state come from
 * `catalog.promotion.ts`, which this registers into like the other two.
 */

const KIND = 'flashsale' as const;

/**
 * A 秒杀价 applies only while it is below the SKU's own price. The editor refuses a
 * higher one; this covers a SKU price lowered later without touching the campaign,
 * so a shopper is never charged more for 秒杀 than without it.
 */
function undercuts(flash: string, own: string): boolean {
  return Money.parse(flash).lt(Money.parse(own));
}

/** The 秒杀价 checkout charges now, by SKU id, for SKUs whose price it undercuts. */
export async function flashSalePrices(
  db: DbOrTx,
  skus: ReadonlyMap<number, { price: string }>,
  now: Date,
): Promise<Map<number, { price: string; activityId: number }>> {
  const live = await repo.livePrices(db, [...skus.keys()], now);
  for (const [skuId, flash] of live) {
    const own = skus.get(skuId);
    if (!own || !undercuts(flash.price, own.price)) live.delete(skuId);
  }
  return live;
}

const port: ProductPromotionPort = {
  async candidates(ctx, productId, includeId) {
    const out: ProductPromotionCandidate[] = [];
    for (const row of await repo.productActivities(ctx.db, productId, includeId)) {
      const skus = await repo.activitySkus(ctx.db, row.id);
      out.push({
        kind: KIND,
        activityId: String(row.id),
        title: row.title,
        status: row.status,
        settings: {
          startAt: row.startAt.toISOString(),
          endAt: row.endAt.toISOString(),
          title: row.title,
          skus: skus.map((sku) => ({ specValues: sku.specValues, price: sku.price })),
        },
      });
    }
    return out;
  },

  async summaries(ctx, productIds, includeIds) {
    return (await repo.productActivitySummaries(ctx.db, productIds, includeIds)).map((row) => ({
      ...row,
      activityId: String(row.id),
    }));
  },
  async save(ctx, { product, settings, activityId }) {
    if (!settings.startAt) throw new DomainError('CATALOG_PROMOTION_INVALID');
    const startAt = new Date(settings.startAt);
    const endAt = new Date(settings.endAt);
    if (endAt.getTime() <= startAt.getTime()) throw new DomainError('CATALOG_PROMOTION_INVALID');

    const owned = new Map(product.skus.map((sku) => [comboKey(sku.specValues), sku]));
    const skus: { skuId: number; price: string }[] = [];
    for (const input of settings.skus) {
      if (input.isEnabled === false) continue;
      const sku = owned.get(comboKey(input.specValues));
      if (!sku) throw new DomainError('CATALOG_PROMOTION_INVALID');
      if (!undercuts(input.price, sku.price)) {
        throw new DomainError('CATALOG_FLASH_SALE_PRICE_TOO_HIGH', {
          details: { specText: sku.specText },
        });
      }
      skus.push({ skuId: Number(sku.id), price: Money.parse(input.price).toString() });
    }
    if (skus.length === 0) throw new DomainError('CATALOG_PROMOTION_INVALID');

    const now = ctx.clock.now();
    const title = settings.title ?? product.name;
    return ctx.withTx(async (tx) => {
      let id: number;
      if (activityId) {
        id = Number(activityId);
        const updated = await repo.updateOpenActivity(tx, id, { title, startAt, endAt, now });
        // Ended between the editor's read and this save: never revive it.
        if (!updated.won) throw new DomainError('CATALOG_PROMOTION_CHANGED');
      } else {
        id = await repo.insertActivity(tx, {
          productId: Number(product.id),
          title,
          startAt,
          endAt,
          now,
        });
      }
      await repo.replaceActivitySkus(tx, id, skus);
      return String(id);
    });
  },

  async end(ctx, activityId) {
    await ctx.withTx(async (tx) => {
      await repo.endActivity(tx, Number(activityId), ctx.clock.now());
    });
  },

  async storefront(ctx, activityId) {
    const row = await repo.findActivity(ctx.db, Number(activityId));
    if (!row) throw new DomainError('CATALOG_PROMOTION_CHANGED');
    const now = ctx.clock.now();
    const own = await catalogRepo.listSkus(ctx.db, row.productId);
    const flash = await flashSalePrices(
      ctx.db,
      new Map(own.filter((sku) => sku.isVisible).map((sku) => [sku.id, { price: sku.price }])),
      now,
    );
    const skus = own
      .filter((sku) => sku.isVisible && flash.get(sku.id)?.activityId === row.id)
      .map((sku) => ({
        skuId: String(sku.id),
        specText: sku.specText,
        specValues: sku.specValues,
        imageUrl: sku.imageUrl,
        price: flash.get(sku.id)!.price,
        // Struck through beside the 秒杀价: what the SKU costs without it.
        originalPrice: sku.price,
        stock: sku.stock,
      }));
    const price =
      skus.length > 0
        ? skus
            .map((sku) => Money.parse(sku.price))
            .reduce(Money.min)
            .toString()
        : '0.00';
    return {
      kind: KIND,
      activityId,
      price,
      originalPrice: skus.find((sku) => sku.price === price)?.originalPrice ?? null,
      endAt: row.endAt.toISOString(),
      canBuy: skus.some((sku) => sku.stock > 0),
      seatsRequired: null,
      shipAfterDays: null,
      // No 秒杀 quota: the product's own 限购 applies at checkout.
      perOrderQuantity: PER_ORDER_UNLIMITED,
      skus,
    };
  },
};

export function registerFlashSaleProductPromotion(): void {
  registerProductPromotionPort(KIND, port);
}
