import type { DbOrTx, Tx } from '@shop/db';
import { flashSaleActivities, flashSaleActivitySkus } from '@shop/db/schema/flash-sale';
import { productPromotions } from '@shop/db/schema/catalog-promotion';
import { productSkus, products } from '@shop/db/schema/catalog';
import { and, asc, count, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { conditionalUpdate, type ConditionalUpdateResult } from '../kernel/tx';

export type FlashSaleRow = typeof flashSaleActivities.$inferSelect;

/** The product's unended flash sales, plus `includeId` (the linked one) even when ended. */
export async function productActivities(
  db: DbOrTx,
  productId: number,
  includeId: number | null,
): Promise<FlashSaleRow[]> {
  return db
    .select()
    .from(flashSaleActivities)
    .where(
      and(
        eq(flashSaleActivities.productId, productId),
        or(
          ne(flashSaleActivities.status, 'ended'),
          includeId === null ? undefined : eq(flashSaleActivities.id, includeId),
        ),
      ),
    )
    .orderBy(asc(flashSaleActivities.id));
}

/** `productActivityIds` for many products at once: what a product card needs to know. */
export async function productActivitySummaries(
  db: DbOrTx,
  productIds: readonly number[],
  includeIds: readonly number[],
): Promise<{ id: number; productId: number; status: string; startAt: Date; endAt: Date }[]> {
  if (productIds.length === 0) return [];
  return db
    .select({
      id: flashSaleActivities.id,
      productId: flashSaleActivities.productId,
      status: flashSaleActivities.status,
      startAt: flashSaleActivities.startAt,
      endAt: flashSaleActivities.endAt,
    })
    .from(flashSaleActivities)
    .where(
      and(
        inArray(flashSaleActivities.productId, [...productIds]),
        or(
          ne(flashSaleActivities.status, 'ended'),
          includeIds.length === 0 ? undefined : inArray(flashSaleActivities.id, [...includeIds]),
        ),
      ),
    );
}
export async function activitySkus(
  db: DbOrTx,
  activityId: number,
): Promise<{ skuId: number; price: string; specValues: Record<string, string> }[]> {
  return db
    .select({
      skuId: flashSaleActivitySkus.skuId,
      price: flashSaleActivitySkus.price,
      specValues: productSkus.specValues,
    })
    .from(flashSaleActivitySkus)
    .innerJoin(productSkus, eq(productSkus.id, flashSaleActivitySkus.skuId))
    .where(eq(flashSaleActivitySkus.activityId, activityId))
    .orderBy(asc(productSkus.sortOrder), asc(productSkus.id));
}

export async function findActivity(db: DbOrTx, id: number): Promise<FlashSaleRow | null> {
  const [row] = await db.select().from(flashSaleActivities).where(eq(flashSaleActivities.id, id));
  return row ?? null;
}

export async function insertActivity(
  tx: Tx,
  values: { productId: number; title: string; startAt: Date; endAt: Date; now: Date },
): Promise<number> {
  const [row] = await tx
    .insert(flashSaleActivities)
    .values({
      productId: values.productId,
      title: values.title,
      startAt: values.startAt,
      endAt: values.endAt,
      createdAt: values.now,
      updatedAt: values.now,
    })
    .returning({ id: flashSaleActivities.id });
  return row!.id;
}

/** Only an unended row moves: an ended flash sale is never written back to life. */
export async function updateOpenActivity(
  tx: Tx,
  id: number,
  values: { title: string; startAt: Date; endAt: Date; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, flashSaleActivities, {
    where: and(eq(flashSaleActivities.id, id), ne(flashSaleActivities.status, 'ended')),
    set: {
      title: values.title,
      startAt: values.startAt,
      endAt: values.endAt,
      updatedAt: values.now,
    },
  });
}

export async function replaceActivitySkus(
  tx: Tx,
  activityId: number,
  skus: readonly { skuId: number; price: string }[],
): Promise<void> {
  await tx.delete(flashSaleActivitySkus).where(eq(flashSaleActivitySkus.activityId, activityId));
  if (skus.length === 0) return;
  await tx
    .insert(flashSaleActivitySkus)
    .values(skus.map((sku) => ({ activityId, skuId: sku.skuId, price: sku.price })));
}

export async function endActivity(tx: Tx, id: number, now: Date): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, flashSaleActivities, {
    where: and(eq(flashSaleActivities.id, id), ne(flashSaleActivities.status, 'ended')),
    set: { status: 'ended', updatedAt: now },
  });
}

/**
 * The 秒杀价 checkout charges right now, by SKU: the product's *current* campaign
 * (its `product_promotions` link) is an active flash sale whose window holds `now`.
 */
export async function livePrices(
  db: DbOrTx,
  skuIds: readonly number[],
  now: Date,
): Promise<Map<number, { price: string; activityId: number }>> {
  const out = new Map<number, { price: string; activityId: number }>();
  if (skuIds.length === 0) return out;
  const rows = await db
    .select({
      skuId: flashSaleActivitySkus.skuId,
      price: flashSaleActivitySkus.price,
      activityId: flashSaleActivities.id,
    })
    .from(flashSaleActivitySkus)
    .innerJoin(flashSaleActivities, eq(flashSaleActivities.id, flashSaleActivitySkus.activityId))
    .innerJoin(
      productPromotions,
      and(
        eq(productPromotions.productId, flashSaleActivities.productId),
        eq(productPromotions.flashSaleActivityId, flashSaleActivities.id),
      ),
    )
    .where(
      and(
        inArray(flashSaleActivitySkus.skuId, [...skuIds]),
        eq(flashSaleActivities.status, 'active'),
        lte(flashSaleActivities.startAt, now),
        gt(flashSaleActivities.endAt, now),
      ),
    );
  for (const row of rows) out.set(row.skuId, { price: row.price, activityId: row.activityId });
  return out;
}

export interface ShownActivityRow {
  id: number;
  productId: number;
  title: string;
  imageUrl: string;
  startAt: Date;
  endAt: Date;
}

/**
 * The flash sales a shopper sees: active, not ended (`now < endAt`), started
 * unless `upcoming`, still the product's current campaign, the product on the
 * shelf and not deleted — the same rows `livePrices` charges by once they
 * start. Live first, soonest-ending; then the upcoming, soonest-starting. With
 * `productIds`, only those products' (one current campaign each, so at most one
 * row per product; the caller puts them in the picked order).
 */
export async function shownActivities(
  db: DbOrTx,
  filters: {
    now: Date;
    upcoming: boolean;
    productIds?: readonly number[] | undefined;
    limit: number;
    offset: number;
  },
): Promise<{ rows: ShownActivityRow[]; total: number }> {
  const { now } = filters;
  const where = and(
    eq(flashSaleActivities.status, 'active'),
    filters.upcoming ? undefined : lte(flashSaleActivities.startAt, now),
    gt(flashSaleActivities.endAt, now),
    eq(products.status, 'on_shelf'),
    isNull(products.deletedAt),
    filters.productIds === undefined
      ? undefined
      : inArray(flashSaleActivities.productId, [...filters.productIds]),
  );
  const notStarted = sql`${flashSaleActivities.startAt} > ${now}`;
  const rows = await db
    .select({
      id: flashSaleActivities.id,
      productId: flashSaleActivities.productId,
      title: flashSaleActivities.title,
      imageUrl: products.imageUrl,
      startAt: flashSaleActivities.startAt,
      endAt: flashSaleActivities.endAt,
    })
    .from(flashSaleActivities)
    .innerJoin(products, eq(products.id, flashSaleActivities.productId))
    .innerJoin(
      productPromotions,
      and(
        eq(productPromotions.productId, flashSaleActivities.productId),
        eq(productPromotions.flashSaleActivityId, flashSaleActivities.id),
      ),
    )
    .where(where)
    .orderBy(
      asc(notStarted),
      asc(
        sql`case when ${notStarted} then ${flashSaleActivities.startAt} else ${flashSaleActivities.endAt} end`,
      ),
      asc(flashSaleActivities.id),
    )
    .limit(filters.limit)
    .offset(filters.offset);
  const [totalRow] = await db
    .select({ value: count() })
    .from(flashSaleActivities)
    .innerJoin(products, eq(products.id, flashSaleActivities.productId))
    .innerJoin(
      productPromotions,
      and(
        eq(productPromotions.productId, flashSaleActivities.productId),
        eq(productPromotions.flashSaleActivityId, flashSaleActivities.id),
      ),
    )
    .where(where);
  return { rows, total: totalRow?.value ?? 0 };
}

/** The 秒杀价 of each SKU in these campaigns, whatever their window. */
export async function activityPrices(
  db: DbOrTx,
  activityIds: readonly number[],
): Promise<{ activityId: number; skuId: number; price: string }[]> {
  if (activityIds.length === 0) return [];
  return db
    .select({
      activityId: flashSaleActivitySkus.activityId,
      skuId: flashSaleActivitySkus.skuId,
      price: flashSaleActivitySkus.price,
    })
    .from(flashSaleActivitySkus)
    .where(inArray(flashSaleActivitySkus.activityId, [...activityIds]));
}
