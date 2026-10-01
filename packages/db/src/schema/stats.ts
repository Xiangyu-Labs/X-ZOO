import { sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, varchar } from 'drizzle-orm/pg-core';

import { createdAt, fk, money, pk } from './_shared';
import { productSkus, products } from './catalog';
import { orders, ordersPlatform } from './order';
import { users } from './user';

/**
 * Behavioural event logs behind the operator dashboards.
 *
 * Deliberately append-only and deliberately lean: three tables, no rollups, no
 * partitioning. One row is one event: the metric is the `kind` and the
 * magnitude is `quantity` / `amount`, rather than a column per metric left zero
 * on most rows.
 *
 * Retention is a scheduled delete by `created_at`, not a schema concern.
 */

/** Which product event a row records. */
export const productEventsKind = pgEnum('product_events_kind', [
  'view',
  'cart',
  'order',
  'pay',
  'refund',
  'favorite',
]);

export const productEvents = pgTable(
  'product_events',
  {
    id: pk(),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    skuId: fk().references(() => productSkus.id, { onDelete: 'set null' }),
    userId: fk().references(() => users.id, { onDelete: 'set null' }),
    orderId: fk().references(() => orders.id, { onDelete: 'set null' }),
    kind: productEventsKind().notNull(),
    /** Units involved. `1` for a view or a favourite. */
    quantity: integer().notNull().default(1),
    /** Money involved, for `pay` and `refund`. */
    amount: money().notNull().default('0.00'),
    /** Cost of the goods, so margin is a sum rather than a join back to a mutable product row. */
    costAmount: money().notNull().default('0.00'),
    platform: ordersPlatform(),
    createdAt: createdAt(),
  },
  (t) => [
    index('product_events_product_idx').on(t.productId, t.kind, t.createdAt),
    index('product_events_created_at_idx').on(t.createdAt),
    index('product_events_user_idx').on(t.userId, t.createdAt),
    index('product_events_order_idx').on(t.orderId),
    check(
      'product_events_non_negative',
      sql`${t.quantity} >= 0 and ${t.amount} >= 0 and ${t.costAmount} >= 0`,
    ),
  ],
);

export type ProductEvent = typeof productEvents.$inferSelect;
export type NewProductEvent = typeof productEvents.$inferInsert;

/** Page views, for the traffic dashboard. Anonymous visits carry a NULL `userId`. */
export const userVisits = pgTable(
  'user_visits',
  {
    id: pk(),
    userId: fk().references(() => users.id, { onDelete: 'set null' }),
    /** Storefront route, without the query string. */
    path: varchar({ length: 255 }).notNull(),
    platform: ordersPlatform(),
    ip: varchar({ length: 45 }),
    /** Coarse geo: the signed-in visitor's default-address province when the view was recorded; null for anonymous views. */
    province: varchar({ length: 64 }),
    /** How long the visitor stayed, in milliseconds. */
    stayMs: integer(),
    createdAt: createdAt(),
  },
  (t) => [
    index('user_visits_created_at_idx').on(t.createdAt),
    index('user_visits_user_idx').on(t.userId, t.createdAt),
    index('user_visits_platform_idx').on(t.platform, t.createdAt),
    check('user_visits_stay_non_negative', sql`${t.stayMs} is null or ${t.stayMs} >= 0`),
  ],
);

export type UserVisit = typeof userVisits.$inferSelect;
export type NewUserVisit = typeof userVisits.$inferInsert;

/**
 * One row per search. The "hot keywords" panel is a `GROUP BY keyword` over a
 * time window, so there is no counter to keep in step.
 */
export const searchLogs = pgTable(
  'search_logs',
  {
    id: pk(),
    userId: fk().references(() => users.id, { onDelete: 'set null' }),
    keyword: varchar({ length: 128 }).notNull(),
    resultCount: integer().notNull().default(0),
    platform: ordersPlatform(),
    createdAt: createdAt(),
  },
  (t) => [
    index('search_logs_keyword_idx').on(t.keyword, t.createdAt),
    index('search_logs_created_at_idx').on(t.createdAt),
    index('search_logs_user_idx').on(t.userId, t.createdAt),
    check('search_logs_result_count_non_negative', sql`${t.resultCount} >= 0`),
  ],
);

export type SearchLog = typeof searchLogs.$inferSelect;
export type NewSearchLog = typeof searchLogs.$inferInsert;
