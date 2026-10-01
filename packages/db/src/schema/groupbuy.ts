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
import { users } from './user';

/**
 * Group buying.
 *
 * The group is a real row with a real seat counter, separate from its members,
 * so taking the last seat is one conditional UPDATE:
 *
 * ```sql
 * UPDATE groupbuy_groups
 *    SET seats_taken = seats_taken + 1
 *  WHERE id = $1 AND status = 'forming' AND expires_at > now()
 *    AND seats_taken < seats_total
 * ```
 *
 * Zero affected rows means the seat was gone. `groupbuy_groups_seats_within_total`
 * is the backstop that makes overselling impossible even if that predicate is
 * ever dropped.
 */

// ---------------------------------------------------------------------------
// activities
// ---------------------------------------------------------------------------

export const groupbuyActivitiesStatus = pgEnum('groupbuy_activities_status', [
  'draft',
  'active',
  'paused',
  'ended',
]);

export const groupbuyActivities = pgTable(
  'groupbuy_activities',
  {
    id: pk(),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    title: varchar({ length: 255 }).notNull(),
    intro: varchar({ length: 255 }),
    imageUrl: varchar({ length: 512 }),
    sliderImages: jsonb().$type<string[]>().notNull().default(emptyJsonArray),
    status: groupbuyActivitiesStatus().notNull().default('draft'),
    /** Group price when the product has a single SKU; per-SKU prices live in `groupbuy_activity_skus`. */
    price: money().notNull(),
    originalPrice: money(),
    cost: money(),
    /** Heads needed to complete a group. */
    seatsRequired: integer().notNull(),
    /** How long a group stays open once opened. */
    groupTtlSeconds: integer().notNull(),
    stock: integer().notNull().default(0),
    sales: integer().notNull().default(0),
    /** Total units the activity may ever sell. NULL = only limited by stock. */
    totalQuota: integer(),
    /** Units one order may buy. */
    perOrderQuantity: integer().notNull().default(1),
    /** Activity window. */
    startAt: instant().notNull(),
    endAt: instant().notNull(),
    shippingTemplateId: fk().references(() => shippingTemplates.id, { onDelete: 'restrict' }),
    views: integer().notNull().default(0),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('groupbuy_activities_product_idx').on(t.productId),
    index('groupbuy_activities_status_idx').on(t.status, t.startAt, t.endAt),
    check('groupbuy_activities_seats_required', sql`${t.seatsRequired} >= 2`),
    check('groupbuy_activities_ttl_positive', sql`${t.groupTtlSeconds} > 0`),
    check(
      'groupbuy_activities_counters_non_negative',
      sql`${t.stock} >= 0 and ${t.sales} >= 0 and ${t.views} >= 0 and (${t.totalQuota} is null or ${t.totalQuota} >= 0)`,
    ),
    check('groupbuy_activities_per_order_positive', sql`${t.perOrderQuantity} >= 1`),
    check(
      'groupbuy_activities_prices_non_negative',
      sql`${t.price} >= 0 and (${t.originalPrice} is null or ${t.originalPrice} >= 0) and (${t.cost} is null or ${t.cost} >= 0)`,
    ),
    check('groupbuy_activities_window_ordered', sql`${t.endAt} > ${t.startAt}`),
  ],
);

export type GroupbuyActivity = typeof groupbuyActivities.$inferSelect;
export type NewGroupbuyActivity = typeof groupbuyActivities.$inferInsert;

/** Per-SKU group price and its own stock ledger. */
export const groupbuyActivitySkus = pgTable(
  'groupbuy_activity_skus',
  {
    id: pk(),
    activityId: fk()
      .notNull()
      .references(() => groupbuyActivities.id, { onDelete: 'cascade' }),
    skuId: fk()
      .notNull()
      .references(() => productSkus.id, { onDelete: 'restrict' }),
    price: money().notNull(),
    stock: integer().notNull().default(0),
    sales: integer().notNull().default(0),
    /** Units of this SKU the activity may sell. NULL = only limited by stock. */
    quota: integer(),
    isEnabled: boolean().notNull().default(true),
  },
  (t) => [
    uniqueIndex('groupbuy_activity_skus_uq').on(t.activityId, t.skuId),
    index('groupbuy_activity_skus_sku_idx').on(t.skuId),
    check('groupbuy_activity_skus_stock_non_negative', sql`${t.stock} >= 0`),
    check('groupbuy_activity_skus_sales_non_negative', sql`${t.sales} >= 0`),
    check('groupbuy_activity_skus_quota_non_negative', sql`${t.quota} is null or ${t.quota} >= 0`),
    check('groupbuy_activity_skus_price_non_negative', sql`${t.price} >= 0`),
  ],
);

export type GroupbuyActivitySku = typeof groupbuyActivitySkus.$inferSelect;
export type NewGroupbuyActivitySku = typeof groupbuyActivitySkus.$inferInsert;

// ---------------------------------------------------------------------------
// groups
// ---------------------------------------------------------------------------

export const groupbuyGroupsStatus = pgEnum('groupbuy_groups_status', [
  'forming',
  'succeeded',
  'failed',
  'cancelled',
]);

export const groupbuyGroups = pgTable(
  'groupbuy_groups',
  {
    id: pk(),
    activityId: fk()
      .notNull()
      .references(() => groupbuyActivities.id, { onDelete: 'restrict' }),
    /**
     * Whoever currently leads the group. Mutable: when the leader refunds, the
     * first remaining member is promoted and this column follows.
     */
    leaderUserId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Copied from the activity when the group opens, so a later edit cannot move the goalposts. */
    seatsTotal: integer().notNull(),
    seatsTaken: integer().notNull().default(0),
    status: groupbuyGroupsStatus().notNull().default('forming'),
    expiresAt: instant().notNull(),
    succeededAt: instant(),
    failedAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('groupbuy_groups_activity_idx').on(t.activityId, t.status),
    index('groupbuy_groups_leader_idx').on(t.leaderUserId),
    // The expiry sweep reads exactly this.
    index('groupbuy_groups_expiry_idx')
      .on(t.expiresAt)
      .where(sql`status = 'forming'`),
    check('groupbuy_groups_seats_total_positive', sql`${t.seatsTotal} >= 2`),
    check('groupbuy_groups_seats_taken_non_negative', sql`${t.seatsTaken} >= 0`),
    check('groupbuy_groups_seats_within_total', sql`${t.seatsTaken} <= ${t.seatsTotal}`),
    check(
      'groupbuy_groups_succeeded_shape',
      sql`(${t.status} = 'succeeded') = (${t.succeededAt} is not null)`,
    ),
    // A completed group is exactly full.
    check(
      'groupbuy_groups_succeeded_is_full',
      sql`${t.status} <> 'succeeded' or ${t.seatsTaken} = ${t.seatsTotal}`,
    ),
  ],
);

export type GroupbuyGroup = typeof groupbuyGroups.$inferSelect;
export type NewGroupbuyGroup = typeof groupbuyGroups.$inferInsert;

export const groupbuyMembersRole = pgEnum('groupbuy_members_role', ['leader', 'member']);

export const groupbuyMembersStatus = pgEnum('groupbuy_members_status', [
  'joined',
  'refunded',
  'cancelled',
]);

/**
 * One participant. `UNIQUE (group_id, user_id)` stops a user joining a group
 * twice without a read-then-write check, and `UNIQUE (order_id)` makes one
 * order belong to at most one group.
 */
export const groupbuyMembers = pgTable(
  'groupbuy_members',
  {
    id: pk(),
    groupId: fk()
      .notNull()
      .references(() => groupbuyGroups.id, { onDelete: 'cascade' }),
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    orderId: fk()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    role: groupbuyMembersRole().notNull(),
    status: groupbuyMembersStatus().notNull().default('joined'),
    /**
     * Identity frozen at join time so the group card does not change under the buyer.
     * Cleared on the member's 注销; the membership itself stays.
     */
    nickname: varchar({ length: 64 }),
    avatarUrl: varchar({ length: 512 }),
    quantity: integer().notNull().default(1),
    leftAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('groupbuy_members_group_user_uq').on(t.groupId, t.userId),
    uniqueIndex('groupbuy_members_order_uq').on(t.orderId),
    // Exactly one leader per group, before and after a promotion.
    uniqueIndex('groupbuy_members_leader_uq')
      .on(t.groupId)
      .where(sql`role = 'leader' and status = 'joined'`),
    index('groupbuy_members_user_idx').on(t.userId),
    check('groupbuy_members_quantity_positive', sql`${t.quantity} >= 1`),
    check('groupbuy_members_left_shape', sql`(${t.status} = 'joined') = (${t.leftAt} is null)`),
  ],
);

export type GroupbuyMember = typeof groupbuyMembers.$inferSelect;
export type NewGroupbuyMember = typeof groupbuyMembers.$inferInsert;
