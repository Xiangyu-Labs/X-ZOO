import type { DbOrTx, Tx } from '@shop/db';
import { flashSaleActivities, flashSaleActivitySkus } from '@shop/db/schema/flash-sale';
import { productPromotions } from '@shop/db/schema/catalog-promotion';
import { productSkus, products } from '@shop/db/schema/catalog';
import { and, asc, count, eq, gt, inArray, isNull, lte, ne, or } from 'drizzle-orm';
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

export interface LiveActivityRow {
  id: number;
  productId: number;
  title: string;
  imageUrl: string;
  startAt: Date;
  endAt: Date;
}

/**
 * The flash sales a shopper sees now: active, `startAt <= now < endAt`, still
 * the product's current campaign, the product on the shelf and not deleted —
 * the same rows `livePrices` charges by. Soonest-ending first. With
 * `productIds`, only those products' (one current campaign each, so at most one
 * row per product; the caller puts them in the picked order).
 */
export async function liveActivities(
  db: DbOrTx,
  filters: { now: Date; productIds?: readonly number[] | undefined; limit: number; offset: number },
): Promise<{ rows: LiveActivityRow[]; total: number }> {
  const where = and(
    eq(flashSaleActivities.status, 'active'),
    lte(flashSaleActivities.startAt, filters.now),
    gt(flashSaleActivities.endAt, filters.now),
    eq(products.status, 'on_shelf'),
    isNull(products.deletedAt),
    filters.productIds === undefined
      ? undefined
      : inArray(flashSaleActivities.productId, [...filters.productIds]),
  );
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
    .orderBy(asc(flashSaleActivities.endAt), asc(flashSaleActivities.id))
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
