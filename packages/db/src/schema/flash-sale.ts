import { sql } from 'drizzle-orm';
import { check, index, pgEnum, pgTable, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { createdAt, fk, instant, money, pk, updatedAt } from './_shared';
import { productSkus, products } from './catalog';

/**
 * 限时秒杀: a product sale mode, edited only in the product editor (#97).
 *
 * Not the retired stand-alone 秒杀 module: there are no 秒杀 pages, routes,
 * orders or stock of its own. A flash sale is a per-SKU price that ordinary
 * checkout charges while `start_at <= now < end_at` (PROMO-004); outside that
 * window the SKU's own price applies. Stock, sales and their restoration on
 * cancel or refund are the product's, through the ordinary order path.
 *
 * `ended` is terminal: a product switched away from 秒杀, or saved again after
 * its window, gets a new row; an ended row is never edited back to life.
 */
export const flashSaleActivitiesStatus = pgEnum('flash_sale_activities_status', [
  'active',
  'ended',
]);

export const flashSaleActivities = pgTable(
  'flash_sale_activities',
  {
    id: pk(),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    title: varchar({ length: 255 }).notNull(),
    status: flashSaleActivitiesStatus().notNull().default('active'),
    startAt: instant().notNull(),
    endAt: instant().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('flash_sale_activities_product_idx').on(t.productId),
    check('flash_sale_activities_window_ordered', sql`${t.endAt} > ${t.startAt}`),
  ],
);

export type FlashSaleActivity = typeof flashSaleActivities.$inferSelect;

export const flashSaleActivitySkus = pgTable(
  'flash_sale_activity_skus',
  {
    id: pk(),
    activityId: fk()
      .notNull()
      .references(() => flashSaleActivities.id, { onDelete: 'cascade' }),
    // A SKU the editor removes takes its 秒杀价 with it: nothing was sold *from*
    // this row (orders point at the SKU itself), so there is no history to keep.
    skuId: fk()
      .notNull()
      .references(() => productSkus.id, { onDelete: 'cascade' }),
    price: money().notNull(),
  },
  (t) => [
    uniqueIndex('flash_sale_activity_skus_uq').on(t.activityId, t.skuId),
    index('flash_sale_activity_skus_sku_idx').on(t.skuId),
    check('flash_sale_activity_skus_price_non_negative', sql`${t.price} >= 0`),
  ],
);

export type FlashSaleActivitySku = typeof flashSaleActivitySkus.$inferSelect;
