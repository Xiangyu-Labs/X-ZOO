import type { DbOrTx } from '@shop/db';
import { PER_ORDER_UNLIMITED } from '@shop/contracts/catalog/per-order';
import type {
  FlashSaleCard,
  FlashSaleListQuery,
  ProductPromotionCandidate,
} from '@shop/contracts/catalog/promotion';
import type { Ctx } from '../kernel/context';
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

type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };

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

/**
 * The storefront cards of these flash sales: the lowest 秒杀价 checkout charges
 * inside the window, beside that SKU's own price — for a live campaign what it
 * charges now (`flashSalePrices`), for an upcoming one what it will charge at
 * the start. A campaign none of whose visible SKUs it undercuts any more (the
 * SKU price was lowered after) sells nothing at 秒杀价, so it has no card.
 */
async function toCards(ctx: Ctx, rows: readonly repo.ShownActivityRow[]): Promise<FlashSaleCard[]> {
  if (rows.length === 0) return [];
  const skusByProduct = await catalogRepo.listSkusForProducts(
    ctx.db,
    rows.map((row) => row.productId),
  );
  const flash = new Map<string, string>();
  for (const sku of await repo.activityPrices(
    ctx.db,
    rows.map((row) => row.id),
  )) {
    flash.set(`${sku.activityId}:${sku.skuId}`, sku.price);
  }
  return rows.flatMap((row) => {
    const onSale = (skusByProduct.get(row.productId) ?? []).flatMap((sku) => {
      const price = flash.get(`${row.id}:${sku.id}`);
      return sku.isVisible && price !== undefined && undercuts(price, sku.price)
        ? [{ sku, price }]
        : [];
    });
    if (onSale.length === 0) return [];
    let cheapest = onSale[0]!;
    for (const item of onSale) {
      if (Money.parse(item.price).lt(Money.parse(cheapest.price))) cheapest = item;
    }
    const stock = onSale.reduce((sum, item) => sum + item.sku.stock, 0);
    return [
      {
        activityId: String(row.id),
        productId: String(row.productId),
        title: row.title,
        imageUrl: row.imageUrl || null,
        price: cheapest.price,
        originalPrice: cheapest.sku.price,
        stock,
        startAt: row.startAt.toISOString(),
        endAt: row.endAt.toISOString(),
        canBuy: stock > 0,
      },
    ];
  });
}

/**
 * 限时秒杀 on now (`catalog.flashSaleList`): soonest-ending first — with
 * `upcoming`, then the ones not started yet, soonest-starting — or with
 * `productIds` exactly those products in that order (a DIY block's pick; a
 * product not on 秒杀 is skipped). Read-only: the 秒杀价 is charged by ordinary
 * checkout (`flashSalePrices`), never by anything here.
 */
export async function flashSaleList(
  ctx: Ctx,
  query: FlashSaleListQuery,
): Promise<Paged<FlashSaleCard>> {
  const upcoming = query.upcoming ?? false;
  if (query.productIds !== undefined) {
    const cards = await flashSaleCardsFor(ctx, query.productIds, { upcoming });
    const from = (query.page - 1) * query.pageSize;
    return {
      items: cards.slice(from, from + query.pageSize),
      total: cards.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
  const { rows, total } = await repo.shownActivities(ctx.db, {
    now: ctx.clock.now(),
    upcoming,
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  });
  return {
    items: await toCards(ctx, rows),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * The cards of these products' flash sales — live, and with `upcoming` also
 * not started yet — in the order given; malformed, repeated or idle ids are
 * skipped.
 */
export async function flashSaleCardsFor(
  ctx: Ctx,
  productIds: readonly string[],
  options: { upcoming: boolean } = { upcoming: false },
): Promise<FlashSaleCard[]> {
  const wanted = [...new Set(productIds.filter((id) => /^[1-9]\d{0,14}$/.test(id)))].map(Number);
  if (wanted.length === 0) return [];
  const { rows } = await repo.shownActivities(ctx.db, {
    now: ctx.clock.now(),
    upcoming: options.upcoming,
    productIds: wanted,
    limit: wanted.length,
    offset: 0,
  });
  const cards = new Map((await toCards(ctx, rows)).map((card) => [Number(card.productId), card]));
  return wanted.flatMap((id) => {
    const card = cards.get(id);
    return card ? [card] : [];
  });
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
