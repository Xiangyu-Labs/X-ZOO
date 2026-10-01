import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { createdAt, deletedAt, emptyJsonArray, fk, instant, money, pk, updatedAt } from './_shared';
import { admins } from './auth';
import { orderItems, orders } from './order';
import { shippingTemplates } from './shipping';
import { users } from './user';

/**
 * Products, their category tree, specs, SKUs, labels, reviews and the card
 * inventory that backs card-key products.
 *
 * Dropped with the retired features: seckill / bargain / member price / VIP
 * product flags, brokerage columns, integral rewards, `mer_id`, `activity`,
 * `command_word`, `soure_link`, `is_sub`, `logistics` (store pickup is gone —
 * everything ships by courier or is delivered virtually).
 */

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

export const productCategories = pgTable(
  'product_categories',
  {
    id: pk(),
    parentId: fk().references((): AnyPgColumn => productCategories.id, { onDelete: 'restrict' }),
    name: varchar({ length: 100 }).notNull(),
    /** Materialised ancestor path, `/3/17/`. Root categories have `/`. Maintained by the service. */
    path: varchar({ length: 255 }).notNull().default('/'),
    /** Depth, 0 for a root category. Kept so "top-level only" queries need no recursion. */
    level: smallint().notNull().default(0),
    iconUrl: varchar({ length: 512 }),
    bannerUrl: varchar({ length: 512 }),
    sortOrder: integer().notNull().default(0),
    isVisible: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('product_categories_parent_idx').on(t.parentId),
    index('product_categories_path_idx').on(t.path),
    index('product_categories_visible_idx').on(t.isVisible, t.sortOrder),
    check('product_categories_level_non_negative', sql`${t.level} >= 0`),
  ],
);

export type ProductCategory = typeof productCategories.$inferSelect;
export type NewProductCategory = typeof productCategories.$inferInsert;

// ---------------------------------------------------------------------------
// products
// ---------------------------------------------------------------------------

/**
 * What the buyer receives: 普通 (physical), 卡密 (a virtual card), 优惠券 (a
 * coupon) or 虚拟 (delivered by hand).
 */
export const productsKind = pgEnum('products_kind', [
  'physical',
  'virtual_card',
  'virtual_coupon',
  'virtual_manual',
]);

export const productsStatus = pgEnum('products_status', ['draft', 'on_shelf', 'off_shelf']);

/** How this product's freight is worked out. */
export const productsFreightMode = pgEnum('products_freight_mode', ['free', 'fixed', 'template']);

/** Whether a buyer's quantity is capped, and per order or over their lifetime. */
export const productsPurchaseLimitMode = pgEnum('products_purchase_limit_mode', [
  'none',
  'per_order',
  'lifetime',
]);

/** A single field of the buyer-filled form some products attach to checkout. */
export interface ProductCustomFormField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'radio' | 'checkbox' | 'image';
  required: boolean;
  options?: string[];
  placeholder?: string;
}

export const products = pgTable(
  'products',
  {
    id: pk(),
    name: varchar({ length: 128 }).notNull(),
    /** Short marketing line under the name. */
    subtitle: varchar({ length: 255 }),
    /** Space-separated search keywords an operator adds by hand. */
    keyword: varchar({ length: 255 }),
    /** Stock-keeping unit code for the whole product. */
    spu: varchar({ length: 32 }),
    barCode: varchar({ length: 32 }),
    kind: productsKind().notNull().default('physical'),
    status: productsStatus().notNull().default('draft'),
    imageUrl: varchar({ length: 512 }).notNull(),
    /** Extra card image used by some DIY components. */
    cardImageUrl: varchar({ length: 512 }),
    sliderImages: jsonb().$type<string[]>().notNull().default(emptyJsonArray),
    videoUrl: varchar({ length: 512 }),
    unitName: varchar({ length: 32 }),
    /** Cheapest live SKU price, denormalised for list sorting and filtering. */
    price: money().notNull().default('0.00'),
    /** Crossed-out reference price. */
    originalPrice: money(),
    /** Cheapest live SKU cost. Operator-only. */
    cost: money(),
    /** Sum of live SKU stock, denormalised. The authoritative number is per SKU. */
    stock: integer().notNull().default(0),
    sales: integer().notNull().default(0),
    /** Padding added to the displayed sales figure. */
    displaySalesBoost: integer().notNull().default(0),
    views: integer().notNull().default(0),
    specMode: boolean().notNull().default(false),
    freightMode: productsFreightMode().notNull().default('template'),
    /** Used when `freightMode = 'fixed'`. */
    fixedFreight: money(),
    /** Used when `freightMode = 'template'`. */
    shippingTemplateId: fk().references(() => shippingTemplates.id, { onDelete: 'restrict' }),
    purchaseLimitMode: productsPurchaseLimitMode().notNull().default('none'),
    purchaseLimitQuantity: integer(),
    minPurchaseQuantity: integer().notNull().default(1),
    isHot: boolean().notNull().default(false),
    isNew: boolean().notNull().default(false),
    isBest: boolean().notNull().default(false),
    isBenefit: boolean().notNull().default(false),
    isRecommended: boolean().notNull().default(false),
    customForm: jsonb().$type<ProductCustomFormField[]>(),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('products_spu_uq').on(t.spu),
    index('products_status_idx').on(t.status, t.sortOrder),
    index('products_price_idx').on(t.price),
    index('products_sales_idx').on(t.sales),
    index('products_created_at_idx').on(t.createdAt),
    index('products_shipping_template_idx').on(t.shippingTemplateId),
    // Substring search for the storefront and the admin picker. Requires the
    // pg_trgm extension, created at the top of the 0000_init migration.
    index('products_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
    index('products_keyword_trgm_idx').using('gin', sql`${t.keyword} gin_trgm_ops`),
    check(
      'products_counters_non_negative',
      sql`${t.stock} >= 0 and ${t.sales} >= 0 and ${t.views} >= 0 and ${t.displaySalesBoost} >= 0`,
    ),
    check(
      'products_prices_non_negative',
      sql`${t.price} >= 0 and (${t.originalPrice} is null or ${t.originalPrice} >= 0) and (${t.cost} is null or ${t.cost} >= 0) and (${t.fixedFreight} is null or ${t.fixedFreight} >= 0)`,
    ),
    check('products_min_purchase_positive', sql`${t.minPurchaseQuantity} >= 1`),
    check(
      'products_limit_quantity',
      sql`(${t.purchaseLimitMode} = 'none' and ${t.purchaseLimitQuantity} is null) or (${t.purchaseLimitMode} <> 'none' and ${t.purchaseLimitQuantity} >= 1)`,
    ),
    check(
      'products_freight_source',
      sql`(${t.freightMode} = 'fixed' and ${t.fixedFreight} is not null) or (${t.freightMode} = 'template' and ${t.shippingTemplateId} is not null) or ${t.freightMode} = 'free'`,
    ),
  ],
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

/** Product ↔ category links, one row each (not a comma-separated column). */
export const productCategoriesMap = pgTable(
  'product_categories_map',
  {
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    categoryId: fk()
      .notNull()
      .references(() => productCategories.id, { onDelete: 'restrict' }),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.categoryId] }),
    index('product_categories_map_category_idx').on(t.categoryId),
  ],
);

export type ProductCategoriesMapRow = typeof productCategoriesMap.$inferSelect;
export type NewProductCategoriesMapRow = typeof productCategoriesMap.$inferInsert;

/** Long HTML body. Split out so product list queries never drag it along. */
export const productDescriptions = pgTable('product_descriptions', {
  productId: fk()
    .primaryKey()
    .references(() => products.id, { onDelete: 'cascade' }),
  contentHtml: text().notNull(),
  updatedAt: updatedAt(),
});

export type ProductDescription = typeof productDescriptions.$inferSelect;
export type NewProductDescription = typeof productDescriptions.$inferInsert;

/** "Customers also bought". Replaces the comma-separated `recommend_list`. */
export const productRecommendations = pgTable(
  'product_recommendations',
  {
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    recommendedProductId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    sortOrder: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.recommendedProductId] }),
    check('product_recommendations_not_self', sql`${t.productId} <> ${t.recommendedProductId}`),
  ],
);

export type ProductRecommendation = typeof productRecommendations.$inferSelect;
export type NewProductRecommendation = typeof productRecommendations.$inferInsert;

// ---------------------------------------------------------------------------
// specs and SKUs
// ---------------------------------------------------------------------------

/** One spec axis of a product, e.g. "颜色". */
export const productSpecs = pgTable(
  'product_specs',
  {
    id: pk(),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    name: varchar({ length: 64 }).notNull(),
    sortOrder: integer().notNull().default(0),
  },
  (t) => [uniqueIndex('product_specs_name_uq').on(t.productId, t.name)],
);

export type ProductSpec = typeof productSpecs.$inferSelect;
export type NewProductSpec = typeof productSpecs.$inferInsert;

/** One value on a spec axis, e.g. "红". */
export const productSpecValues = pgTable(
  'product_spec_values',
  {
    id: pk(),
    specId: fk()
      .notNull()
      .references(() => productSpecs.id, { onDelete: 'cascade' }),
    value: varchar({ length: 64 }).notNull(),
    imageUrl: varchar({ length: 512 }),
    sortOrder: integer().notNull().default(0),
  },
  (t) => [uniqueIndex('product_spec_values_value_uq').on(t.specId, t.value)],
);

export type ProductSpecValue = typeof productSpecValues.$inferSelect;
export type NewProductSpecValue = typeof productSpecValues.$inferInsert;

/**
 * A buyable variant. This is the row stock is decremented on, and the only
 * place stock is authoritative.
 *
 * `skuCode` is the variant's stable code (not `unique`, a reserved word);
 * `specText` is its spec values joined for display.
 */
export const productSkus = pgTable(
  'product_skus',
  {
    id: pk(),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** Stable, opaque, globally unique variant key. Carried on order items and cart rows. */
    skuCode: varchar({ length: 32 }).notNull(),
    /** Human-readable variant label joined with `|`, e.g. `红|XL`. Empty string for single-spec products. */
    specText: varchar({ length: 255 }).notNull().default(''),
    /** `{ "颜色": "红", "尺码": "XL" }`. Empty object for single-spec products. */
    specValues: jsonb()
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    imageUrl: varchar({ length: 512 }),
    price: money().notNull(),
    originalPrice: money(),
    cost: money(),
    stock: integer().notNull().default(0),
    sales: integer().notNull().default(0),
    barCode: varchar({ length: 50 }),
    /** Kilograms. */
    weight: numeric({ precision: 12, scale: 3 }),
    /** Cubic metres. */
    volume: numeric({ precision: 12, scale: 4 }),
    isDefault: boolean().notNull().default(false),
    isVisible: boolean().notNull().default(true),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('product_skus_code_uq').on(t.skuCode),
    uniqueIndex('product_skus_spec_uq').on(t.productId, t.specText),
    index('product_skus_product_idx').on(t.productId),
    uniqueIndex('product_skus_default_uq')
      .on(t.productId)
      .where(sql`is_default`),
    // Stock never goes negative: the last-item race is decided here, not by a
    // read-then-write in the service.
    check('product_skus_stock_non_negative', sql`${t.stock} >= 0`),
    check('product_skus_sales_non_negative', sql`${t.sales} >= 0`),
    check(
      'product_skus_prices_non_negative',
      sql`${t.price} >= 0 and (${t.originalPrice} is null or ${t.originalPrice} >= 0) and (${t.cost} is null or ${t.cost} >= 0)`,
    ),
    check(
      'product_skus_measures_non_negative',
      sql`(${t.weight} is null or ${t.weight} >= 0) and (${t.volume} is null or ${t.volume} >= 0)`,
    ),
  ],
);

export type ProductSku = typeof productSkus.$inferSelect;
export type NewProductSku = typeof productSkus.$inferInsert;

// ---------------------------------------------------------------------------
// card-key inventory
// ---------------------------------------------------------------------------

export const productVirtualCardsState = pgEnum('product_virtual_cards_state', [
  'unclaimed',
  'claimed',
  'void',
]);

/**
 * Card-key stock for `products.kind = 'virtual_card'`.
 *
 * Claiming is a single conditional UPDATE:
 *
 * ```sql
 * UPDATE product_virtual_cards
 *    SET state = 'claimed', order_item_id = $1, claimed_by_user_id = $2, claimed_at = now()
 *  WHERE id = (SELECT id FROM product_virtual_cards
 *               WHERE sku_id = $3 AND state = 'unclaimed'
 *               ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
 * ```
 *
 * `product_virtual_cards_order_item_uq` makes a second card for the same order
 * item impossible even if the effect ledger retries. One order item therefore
 * carries at most one card; a card-kind order item is consequently limited to
 * quantity 1, and checkout enforces that.
 */
export const productVirtualCards = pgTable(
  'product_virtual_cards',
  {
    id: pk(),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    skuId: fk()
      .notNull()
      .references(() => productSkus.id, { onDelete: 'cascade' }),
    /** Stable opaque handle shown to the buyer instead of the raw card. */
    cardKey: varchar({ length: 32 }).notNull(),
    cardNo: varchar({ length: 255 }).notNull(),
    cardSecret: varchar({ length: 255 }),
    state: productVirtualCardsState().notNull().default('unclaimed'),
    orderItemId: fk().references((): AnyPgColumn => orderItems.id, { onDelete: 'set null' }),
    claimedByUserId: fk().references(() => users.id, { onDelete: 'set null' }),
    claimedAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('product_virtual_cards_key_uq').on(t.cardKey),
    uniqueIndex('product_virtual_cards_order_item_uq')
      .on(t.orderItemId)
      .where(sql`order_item_id is not null`),
    index('product_virtual_cards_available_idx')
      .on(t.skuId, t.id)
      .where(sql`state = 'unclaimed'`),
    check(
      'product_virtual_cards_claim_consistent',
      sql`(${t.state} = 'claimed') = (${t.orderItemId} is not null)`,
    ),
  ],
);

export type ProductVirtualCard = typeof productVirtualCards.$inferSelect;
export type NewProductVirtualCard = typeof productVirtualCards.$inferInsert;

// ---------------------------------------------------------------------------
// labels, params, protections
// ---------------------------------------------------------------------------

export const productLabelCategories = pgTable(
  'product_label_categories',
  {
    id: pk(),
    name: varchar({ length: 64 }).notNull(),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [uniqueIndex('product_label_categories_name_uq').on(t.name)],
);

export type ProductLabelCategory = typeof productLabelCategories.$inferSelect;
export type NewProductLabelCategory = typeof productLabelCategories.$inferInsert;

/** How a label renders on a product card. */
export const productLabelsStyle = pgEnum('product_labels_style', ['text', 'image']);

export const productLabels = pgTable(
  'product_labels',
  {
    id: pk(),
    categoryId: fk().references(() => productLabelCategories.id, { onDelete: 'set null' }),
    name: varchar({ length: 64 }).notNull(),
    style: productLabelsStyle().notNull().default('text'),
    fontColor: varchar({ length: 32 }),
    backgroundColor: varchar({ length: 32 }),
    borderColor: varchar({ length: 32 }),
    imageUrl: varchar({ length: 512 }),
    /** Whether the storefront renders it; an operator can keep a label for filtering only. */
    isVisible: boolean().notNull().default(true),
    isEnabled: boolean().notNull().default(true),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('product_labels_name_uq').on(t.name),
    index('product_labels_category_idx').on(t.categoryId),
  ],
);

export type ProductLabel = typeof productLabels.$inferSelect;
export type NewProductLabel = typeof productLabels.$inferInsert;

/** Product ↔ label links, one row each (not a comma-separated column). */
export const productLabelsMap = pgTable(
  'product_labels_map',
  {
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    labelId: fk()
      .notNull()
      .references(() => productLabels.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.labelId] }),
    index('product_labels_map_label_idx').on(t.labelId),
  ],
);

export type ProductLabelsMapRow = typeof productLabelsMap.$inferSelect;
export type NewProductLabelsMapRow = typeof productLabelsMap.$inferInsert;

/** Reusable "参数" rows an operator picks from when editing a product. */
export const productParamTemplates = pgTable(
  'product_param_templates',
  {
    id: pk(),
    name: varchar({ length: 64 }).notNull(),
    /** Newline-separated suggested values. */
    suggestedValues: text(),
    isEnabled: boolean().notNull().default(true),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [uniqueIndex('product_param_templates_name_uq').on(t.name)],
);

export type ProductParamTemplate = typeof productParamTemplates.$inferSelect;
export type NewProductParamTemplate = typeof productParamTemplates.$inferInsert;

/** The parameters actually shown on one product's detail page. */
export const productParams = pgTable(
  'product_params',
  {
    id: pk(),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    templateId: fk().references(() => productParamTemplates.id, { onDelete: 'set null' }),
    name: varchar({ length: 64 }).notNull(),
    value: varchar({ length: 255 }).notNull(),
    sortOrder: integer().notNull().default(0),
  },
  (t) => [uniqueIndex('product_params_name_uq').on(t.productId, t.name)],
);

export type ProductParam = typeof productParams.$inferSelect;
export type NewProductParam = typeof productParams.$inferInsert;

/** "七天无理由退换" style guarantee badges. */
export const productProtections = pgTable(
  'product_protections',
  {
    id: pk(),
    title: varchar({ length: 64 }).notNull(),
    content: varchar({ length: 2000 }),
    iconUrl: varchar({ length: 512 }),
    isEnabled: boolean().notNull().default(true),
    sortOrder: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [uniqueIndex('product_protections_title_uq').on(t.title)],
);

export type ProductProtection = typeof productProtections.$inferSelect;
export type NewProductProtection = typeof productProtections.$inferInsert;

/** Product ↔ protection links, one row each (not a comma-separated column). */
export const productProtectionsMap = pgTable(
  'product_protections_map',
  {
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    protectionId: fk()
      .notNull()
      .references(() => productProtections.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.protectionId] }),
    index('product_protections_map_protection_idx').on(t.protectionId),
  ],
);

export type ProductProtectionsMapRow = typeof productProtectionsMap.$inferSelect;
export type NewProductProtectionsMapRow = typeof productProtectionsMap.$inferInsert;

// ---------------------------------------------------------------------------
// favourites and reviews
// ---------------------------------------------------------------------------

/** A user's 收藏: one row per (user, product). */
export const productFavorites = pgTable(
  'product_favorites',
  {
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.productId] }),
    index('product_favorites_product_idx').on(t.productId),
  ],
);

export type ProductFavorite = typeof productFavorites.$inferSelect;
export type NewProductFavorite = typeof productFavorites.$inferInsert;

export const productReviewsStatus = pgEnum('product_reviews_status', [
  'pending',
  'published',
  'hidden',
]);

export const productReviews = pgTable(
  'product_reviews',
  {
    id: pk(),
    productId: fk()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    skuId: fk().references(() => productSkus.id, { onDelete: 'set null' }),
    userId: fk().references(() => users.id, { onDelete: 'set null' }),
    orderId: fk().references((): AnyPgColumn => orders.id, { onDelete: 'set null' }),
    /** One review per purchased line. Enforced below. */
    orderItemId: fk().references((): AnyPgColumn => orderItems.id, { onDelete: 'set null' }),
    /**
     * Author identity frozen at write time; a later nickname change must not rewrite a review.
     * Set only on operator-seeded reviews (no `userId`); cleared on the author's 注销.
     */
    authorNickname: varchar({ length: 64 }),
    authorAvatarUrl: varchar({ length: 512 }),
    /** Variant label frozen at write time. */
    specText: varchar({ length: 255 }),
    productScore: smallint().notNull(),
    serviceScore: smallint().notNull(),
    content: varchar({ length: 1000 }),
    images: jsonb().$type<string[]>().notNull().default(emptyJsonArray),
    status: productReviewsStatus().notNull().default('published'),
    /**
     * Why a shopper's review is waiting in 待审核 rather than published, when
     * the reason is 内容安全 (C09): `sec_check_risky`, `sec_check_review`,
     * `sec_check_unavailable`, `sec_check_unchecked` (author has no mini-program
     * openid) or `sec_check_image_unchecked` (a picture WeChat could not check).
     * `null` for everything else, including a review held back only because
     * 评价需审核 is on.
     */
    moderationReason: varchar({ length: 32 }),
    replyContent: varchar({ length: 500 }),
    replyAt: instant(),
    replyByAdminId: fk().references((): AnyPgColumn => admins.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('product_reviews_product_idx').on(t.productId, t.status, t.createdAt),
    index('product_reviews_user_idx').on(t.userId),
    uniqueIndex('product_reviews_order_item_uq')
      .on(t.orderItemId)
      .where(sql`order_item_id is not null`),
    check(
      'product_reviews_scores_range',
      sql`${t.productScore} between 1 and 5 and ${t.serviceScore} between 1 and 5`,
    ),
  ],
);

export type ProductReview = typeof productReviews.$inferSelect;
export type NewProductReview = typeof productReviews.$inferInsert;
