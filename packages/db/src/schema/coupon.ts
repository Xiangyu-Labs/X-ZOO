import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { createdAt, deletedAt, fk, instant, money, pk, updatedAt } from './_shared';
import { productCategories, products } from './catalog';
import { orders } from './order';
import { users } from './user';

/**
 * Coupon templates and the coupons users hold.
 *
 * One concept, one table each: `coupon_templates` is what an operator issues,
 * `user_coupons` is what a user holds, and a claim is simply a `user_coupons`
 * row — there is no separate claim log.
 *
 * There are no member-only or points-priced coupons: paid membership and
 * points are retired features.
 */

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

/** What the coupon may be spent on. */
export const couponTemplatesScope = pgEnum('coupon_templates_scope', [
  'all_products',
  'categories',
  'products',
]);

/** How a user comes to hold one. */
export const couponTemplatesClaimMode = pgEnum('coupon_templates_claim_mode', [
  'manual',
  'new_user',
  'order_gift',
  'admin_grant',
]);

/** How the coupon's own validity window is worked out. */
export const couponTemplatesValidityMode = pgEnum('coupon_templates_validity_mode', [
  'fixed_window',
  'days_after_claim',
]);

export const couponTemplatesStatus = pgEnum('coupon_templates_status', [
  'draft',
  'active',
  'disabled',
]);

export const couponTemplates = pgTable(
  'coupon_templates',
  {
    id: pk(),
    name: varchar({ length: 64 }).notNull(),
    scope: couponTemplatesScope().notNull().default('all_products'),
    claimMode: couponTemplatesClaimMode().notNull().default('manual'),
    status: couponTemplatesStatus().notNull().default('draft'),
    /** Face value subtracted from the order subtotal. */
    discountAmount: money().notNull(),
    /** Minimum subtotal the coupon may be applied to. `0.00` means no minimum. */
    minSpend: money().notNull().default('0.00'),
    validityMode: couponTemplatesValidityMode().notNull(),
    /** `fixed_window`: the window the coupon may be spent in. */
    validFrom: instant(),
    validTo: instant(),
    /** `days_after_claim`: the coupon expires this many days after it is claimed. */
    validDays: integer(),
    /** Window in which the coupon may be claimed. NULL on either side = unbounded. */
    claimFrom: instant(),
    claimTo: instant(),
    /** TRUE = infinite supply; `totalCount` / `remainingCount` are then NULL. */
    isUnlimitedSupply: boolean().notNull().default(false),
    totalCount: integer(),
    /**
     * Decremented by a conditional `UPDATE … WHERE remaining_count >= 1`.
     * The CHECK below is the backstop that makes overselling impossible.
     */
    remainingCount: integer(),
    /** Maximum a single user may hold from this template. NULL = unlimited. */
    perUserLimit: integer(),
    /** `order_gift` only: the paid amount that earns the coupon. NULL = every paid order. */
    giftMinOrderAmount: money(),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('coupon_templates_status_idx').on(t.status, t.sortOrder),
    index('coupon_templates_claim_mode_idx').on(t.claimMode, t.status),
    check('coupon_templates_discount_positive', sql`${t.discountAmount} > 0`),
    check('coupon_templates_min_spend_non_negative', sql`${t.minSpend} >= 0`),
    check(
      'coupon_templates_counts_non_negative',
      sql`(${t.totalCount} is null or ${t.totalCount} >= 0) and (${t.remainingCount} is null or ${t.remainingCount} >= 0)`,
    ),
    check(
      'coupon_templates_remaining_within_total',
      sql`${t.remainingCount} is null or ${t.totalCount} is null or ${t.remainingCount} <= ${t.totalCount}`,
    ),
    // An unlimited template carries no counters; a limited one carries both.
    check(
      'coupon_templates_supply_shape',
      sql`(${t.isUnlimitedSupply} and ${t.totalCount} is null and ${t.remainingCount} is null) or (not ${t.isUnlimitedSupply} and ${t.totalCount} is not null and ${t.remainingCount} is not null)`,
    ),
    check(
      'coupon_templates_validity_shape',
      sql`(${t.validityMode} = 'fixed_window' and ${t.validFrom} is not null and ${t.validTo} is not null and ${t.validDays} is null) or (${t.validityMode} = 'days_after_claim' and ${t.validDays} >= 1 and ${t.validFrom} is null and ${t.validTo} is null)`,
    ),
    check(
      'coupon_templates_per_user_limit_positive',
      sql`${t.perUserLimit} is null or ${t.perUserLimit} >= 1`,
    ),
  ],
);

export type CouponTemplate = typeof couponTemplates.$inferSelect;
export type NewCouponTemplate = typeof couponTemplates.$inferInsert;

/** Applicability list for `scope = 'products'`. Replaces the comma-separated `product_id` column. */
export const couponTemplateProducts = pgTable(
  'coupon_template_products',
  {
    templateId: fk()
      .notNull()
      .references(() => couponTemplates.id, { onDelete: 'cascade' }),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.templateId, t.productId] }),
    index('coupon_template_products_product_idx').on(t.productId),
  ],
);

export type CouponTemplateProduct = typeof couponTemplateProducts.$inferSelect;
export type NewCouponTemplateProduct = typeof couponTemplateProducts.$inferInsert;

/** Applicability list for `scope = 'categories'`. */
export const couponTemplateCategories = pgTable(
  'coupon_template_categories',
  {
    templateId: fk()
      .notNull()
      .references(() => couponTemplates.id, { onDelete: 'cascade' }),
    categoryId: fk()
      .notNull()
      .references(() => productCategories.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.templateId, t.categoryId] }),
    index('coupon_template_categories_category_idx').on(t.categoryId),
  ],
);

export type CouponTemplateCategory = typeof couponTemplateCategories.$inferSelect;
export type NewCouponTemplateCategory = typeof couponTemplateCategories.$inferInsert;

/**
 * "Buy this product, get this coupon."
 * Lives here rather than in `catalog.ts` so the coupon domain owns every
 * product ↔ coupon link.
 */
export const productGiftCoupons = pgTable(
  'product_gift_coupons',
  {
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    templateId: fk()
      .notNull()
      .references(() => couponTemplates.id, { onDelete: 'cascade' }),
    sortOrder: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.templateId] }),
    index('product_gift_coupons_template_idx').on(t.templateId),
  ],
);

export type ProductGiftCoupon = typeof productGiftCoupons.$inferSelect;
export type NewProductGiftCoupon = typeof productGiftCoupons.$inferInsert;

// ---------------------------------------------------------------------------
// user coupons
// ---------------------------------------------------------------------------

export const userCouponsStatus = pgEnum('user_coupons_status', [
  'unused',
  'used',
  'expired',
  'revoked',
]);

/** Where this particular coupon came from. */
export const userCouponsSourceKind = pgEnum('user_coupons_source_kind', [
  'claim',
  'gift_order',
  'gift_new_user',
  'admin_grant',
]);

/**
 * A coupon in a user's wallet.
 *
 * **Per-user limit.** `claimSlot` is the 1-based ordinal of this user's claim
 * for the template, and `user_coupons_slot_uq` makes `(template, user, slot)`
 * unique. A claim computes `slot = max(existing slot) + 1` and asserts that
 * the user holds fewer than `template.per_user_limit` coupons that are not
 * revoked; two concurrent claims therefore compute the same slot and exactly
 * one survives — no advisory lock, no read-then-write window. A one-per-user
 * template is just `per_user_limit = 1`. See SCHEMA.md §3.2.
 *
 * **Gift issuance.** `user_coupons_order_gift_uq` makes one (order, template)
 * gift impossible to issue twice, so the post-payment effect ledger can retry
 * a gift handler freely.
 */
export const userCoupons = pgTable(
  'user_coupons',
  {
    id: pk(),
    templateId: fk()
      .notNull()
      .references(() => couponTemplates.id, { onDelete: 'restrict' }),
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    claimSlot: integer().notNull(),
    sourceKind: userCouponsSourceKind().notNull(),
    /** Set for `gift_order`: the paid order that earned this coupon. */
    sourceOrderId: fk().references((): AnyPgColumn => orders.id, { onDelete: 'set null' }),
    /** Snapshot: the template may be renamed or re-priced after issue. */
    title: varchar({ length: 64 }).notNull(),
    discountAmount: money().notNull(),
    minSpend: money().notNull(),
    status: userCouponsStatus().notNull().default('unused'),
    validFrom: instant().notNull(),
    validTo: instant().notNull(),
    usedAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('user_coupons_slot_uq').on(t.templateId, t.userId, t.claimSlot),
    uniqueIndex('user_coupons_order_gift_uq')
      .on(t.sourceOrderId, t.templateId)
      .where(sql`source_kind = 'gift_order'`),
    index('user_coupons_user_idx').on(t.userId, t.status, t.validTo),
    index('user_coupons_expiry_idx')
      .on(t.validTo)
      .where(sql`status = 'unused'`),
    index('user_coupons_template_idx').on(t.templateId),
    check('user_coupons_slot_positive', sql`${t.claimSlot} >= 1`),
    check('user_coupons_amounts_non_negative', sql`${t.discountAmount} > 0 and ${t.minSpend} >= 0`),
    check('user_coupons_window_ordered', sql`${t.validTo} > ${t.validFrom}`),
    check('user_coupons_used_at_present', sql`(${t.status} = 'used') = (${t.usedAt} is not null)`),
    check(
      'user_coupons_gift_order_present',
      sql`${t.sourceKind} <> 'gift_order' or ${t.sourceOrderId} is not null`,
    ),
  ],
);

export type UserCoupon = typeof userCoupons.$inferSelect;
export type NewUserCoupon = typeof userCoupons.$inferInsert;
