import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { createdAt, deletedAt, emptyJsonArray, fk, instant, money, pk, updatedAt } from './_shared';
import { productSkus, products } from './catalog';
import { orders } from './order';
import { shippingTemplates } from './shipping';

/**
 * Presale.
 *
 * ## The deposit flow is declared but inert
 *
 * An activity carries a payment mode (全款 / 定金), a deposit amount and a
 * balance window, and the admin form edits them — but no order flow reads
 * them yet. A presale order is one order, paid once, in full. The columns are
 * kept, and `presale_orders` carries the stage machine, so the deposit flow
 * can be switched on without a schema change. Until then every presale order
 * goes straight to `final_paid`.
 *
 * ## Four ledgers
 *
 * A presale sale moves stock on four rows: `presale_activities`,
 * `presale_activity_skus`, `products` and `product_skus`. REFUND-002 requires
 * every one of them to be restored exactly on a refund, so each movement is
 * written to `presale_stock_ledger` with `UNIQUE (order_id, reason)` — the
 * reservation and its release can therefore each happen at most once, however
 * often the effect ledger retries.
 */

// ---------------------------------------------------------------------------
// activities
// ---------------------------------------------------------------------------

/** `full` = one payment; `deposit` = a deposit, then the balance (not driven yet). */
export const presaleActivitiesPaymentMode = pgEnum('presale_activities_payment_mode', [
  'full',
  'deposit',
]);

export const presaleActivitiesStatus = pgEnum('presale_activities_status', [
  'draft',
  'active',
  'paused',
  'ended',
]);

export const presaleActivities = pgTable(
  'presale_activities',
  {
    id: pk(),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    title: varchar({ length: 255 }).notNull(),
    intro: varchar({ length: 255 }),
    imageUrl: varchar({ length: 512 }),
    sliderImages: jsonb().$type<string[]>().notNull().default(emptyJsonArray),
    status: presaleActivitiesStatus().notNull().default('draft'),
    paymentMode: presaleActivitiesPaymentMode().notNull().default('full'),
    price: money().notNull(),
    originalPrice: money(),
    /** `deposit` mode only: what the buyer pays up front. */
    depositAmount: money(),
    stock: integer().notNull().default(0),
    sales: integer().notNull().default(0),
    totalQuota: integer(),
    perOrderQuantity: integer().notNull().default(1),
    /** The window in which the presale may be bought. */
    startAt: instant().notNull(),
    endAt: instant().notNull(),
    /** `deposit` mode only: the window in which the balance may be paid. */
    finalPaymentStartAt: instant(),
    finalPaymentEndAt: instant(),
    /** Days after (final) payment before the goods ship. */
    shipAfterDays: integer().notNull().default(0),
    shippingTemplateId: fk().references(() => shippingTemplates.id, { onDelete: 'restrict' }),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('presale_activities_product_idx').on(t.productId),
    index('presale_activities_status_idx').on(t.status, t.startAt, t.endAt),
    // The "unlist expired presales" sweep reads this (SMOKE-011).
    index('presale_activities_expiry_idx')
      .on(t.endAt)
      .where(sql`status = 'active'`),
    check(
      'presale_activities_counters_non_negative',
      sql`${t.stock} >= 0 and ${t.sales} >= 0 and ${t.shipAfterDays} >= 0 and (${t.totalQuota} is null or ${t.totalQuota} >= 0)`,
    ),
    check('presale_activities_per_order_positive', sql`${t.perOrderQuantity} >= 1`),
    check(
      'presale_activities_prices_non_negative',
      sql`${t.price} >= 0 and (${t.originalPrice} is null or ${t.originalPrice} >= 0) and (${t.depositAmount} is null or ${t.depositAmount} >= 0)`,
    ),
    check('presale_activities_window_ordered', sql`${t.endAt} > ${t.startAt}`),
    // A deposit presale needs a deposit and a balance window; a full one has neither.
    check(
      'presale_activities_deposit_shape',
      sql`(${t.paymentMode} = 'deposit' and ${t.depositAmount} is not null and ${t.depositAmount} < ${t.price} and ${t.finalPaymentStartAt} is not null and ${t.finalPaymentEndAt} is not null and ${t.finalPaymentEndAt} > ${t.finalPaymentStartAt})
          or (${t.paymentMode} = 'full' and ${t.depositAmount} is null and ${t.finalPaymentStartAt} is null and ${t.finalPaymentEndAt} is null)`,
    ),
  ],
);

export type PresaleActivity = typeof presaleActivities.$inferSelect;
export type NewPresaleActivity = typeof presaleActivities.$inferInsert;

export const presaleActivitySkus = pgTable(
  'presale_activity_skus',
  {
    id: pk(),
    activityId: fk()
      .notNull()
      .references(() => presaleActivities.id, { onDelete: 'cascade' }),
    skuId: fk()
      .notNull()
      .references(() => productSkus.id, { onDelete: 'restrict' }),
    price: money().notNull(),
    depositAmount: money(),
    stock: integer().notNull().default(0),
    sales: integer().notNull().default(0),
    quota: integer(),
    isEnabled: boolean().notNull().default(true),
  },
  (t) => [
    uniqueIndex('presale_activity_skus_uq').on(t.activityId, t.skuId),
    index('presale_activity_skus_sku_idx').on(t.skuId),
    check('presale_activity_skus_stock_non_negative', sql`${t.stock} >= 0`),
    check('presale_activity_skus_sales_non_negative', sql`${t.sales} >= 0`),
    check('presale_activity_skus_quota_non_negative', sql`${t.quota} is null or ${t.quota} >= 0`),
    check(
      'presale_activity_skus_prices_non_negative',
      sql`${t.price} >= 0 and (${t.depositAmount} is null or ${t.depositAmount} >= 0)`,
    ),
  ],
);

export type PresaleActivitySku = typeof presaleActivitySkus.$inferSelect;
export type NewPresaleActivitySku = typeof presaleActivitySkus.$inferInsert;

// ---------------------------------------------------------------------------
// presale orders
// ---------------------------------------------------------------------------

/**
 * ```
 * full mode:     final_pending ──pay──► final_paid
 * deposit mode:  deposit_pending ──pay──► deposit_paid ──window opens──► final_pending ──pay──► final_paid
 *                        └──────────── expired / cancelled ────────────┘
 * ```
 */
export const presaleOrdersStage = pgEnum('presale_orders_stage', [
  'deposit_pending',
  'deposit_paid',
  'final_pending',
  'final_paid',
  'expired',
  'cancelled',
]);

/** Links an order to the presale it came from. One row per presale order. */
export const presaleOrders = pgTable(
  'presale_orders',
  {
    orderId: fk()
      .primaryKey()
      .references(() => orders.id, { onDelete: 'cascade' }),
    activityId: fk()
      .notNull()
      .references(() => presaleActivities.id, { onDelete: 'restrict' }),
    /** Snapshot: the activity may be re-configured after the order was placed. */
    paymentMode: presaleActivitiesPaymentMode().notNull(),
    stage: presaleOrdersStage().notNull(),
    depositAmount: money(),
    finalAmount: money(),
    depositPaidAt: instant(),
    finalPaidAt: instant(),
    /** Deadline for the balance. The expiry sweep reads it. */
    finalDueAt: instant(),
    /** Earliest ship date, derived from `presale_activities.shipAfterDays` at payment. */
    shipNotBeforeAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('presale_orders_activity_idx').on(t.activityId),
    index('presale_orders_final_due_idx')
      .on(t.finalDueAt)
      .where(sql`stage = 'final_pending'`),
    check(
      'presale_orders_amounts_non_negative',
      sql`(${t.depositAmount} is null or ${t.depositAmount} >= 0) and (${t.finalAmount} is null or ${t.finalAmount} >= 0)`,
    ),
    check(
      'presale_orders_full_mode_shape',
      sql`${t.paymentMode} <> 'full' or (${t.depositAmount} is null and ${t.stage} in ('final_pending','final_paid','expired','cancelled'))`,
    ),
  ],
);

export type PresaleOrder = typeof presaleOrders.$inferSelect;
export type NewPresaleOrder = typeof presaleOrders.$inferInsert;

// ---------------------------------------------------------------------------
// stock ledger
// ---------------------------------------------------------------------------

export const presaleStockLedgerReason = pgEnum('presale_stock_ledger_reason', [
  'reserve',
  'release',
]);

/**
 * Every movement of presale stock, so a refund can put back exactly what was
 * taken. `UNIQUE (order_id, reason)` makes each direction happen at most once
 * per order (QUEUE-008, REFUND-002).
 *
 * The four `*Delta` columns are the four ledgers REFUND-002 names; they are
 * recorded together so a restore is one row read rather than four
 * recomputations.
 */
export const presaleStockLedger = pgTable(
  'presale_stock_ledger',
  {
    id: pk(),
    activityId: fk()
      .notNull()
      .references(() => presaleActivities.id, { onDelete: 'restrict' }),
    activitySkuId: fk().references(() => presaleActivitySkus.id, { onDelete: 'restrict' }),
    skuId: fk()
      .notNull()
      .references(() => productSkus.id, { onDelete: 'restrict' }),
    orderId: fk()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    reason: presaleStockLedgerReason().notNull(),
    /** Units moved. Always positive; `reason` gives the direction. */
    quantity: integer().notNull(),
    /** Signed change applied to each of the four counters, for an exact restore. */
    activityStockDelta: integer().notNull(),
    activitySalesDelta: integer().notNull(),
    productStockDelta: integer().notNull(),
    productSalesDelta: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('presale_stock_ledger_order_reason_uq').on(t.orderId, t.reason),
    index('presale_stock_ledger_activity_idx').on(t.activityId, t.createdAt),
    check('presale_stock_ledger_quantity_positive', sql`${t.quantity} >= 1`),
  ],
);

export type PresaleStockLedgerRow = typeof presaleStockLedger.$inferSelect;
export type NewPresaleStockLedgerRow = typeof presaleStockLedger.$inferInsert;
