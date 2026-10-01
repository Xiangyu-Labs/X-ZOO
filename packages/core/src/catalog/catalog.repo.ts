import type { DbOrTx, Tx } from '@shop/db';
import {
  productCategories,
  productCategoriesMap,
  productDescriptions,
  productFavorites,
  productLabelCategories,
  productLabels,
  productLabelsMap,
  productParamTemplates,
  productParams,
  productProtections,
  productProtectionsMap,
  productRecommendations,
  productReviews,
  productSkus,
  productSpecValues,
  productSpecs,
  productVirtualCards,
  products,
} from '@shop/db/schema/catalog';
import { productGiftCoupons } from '@shop/db/schema/coupon';
import { productEvents, searchLogs } from '@shop/db/schema/stats';
import { effects } from '@shop/db/schema/system';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import { allOf, conditionalUpdate, type ConditionalUpdateResult } from '../kernel/tx';
import { likePattern } from './catalog.rules';

/**
 * The only file in the catalog domain that touches Drizzle tables, apart from
 * the test fixtures in `catalog.fixtures.repo.ts`.
 *
 * A repo function is a *statement*, not a decision: it returns rows, or the
 * number of rows a conditional update changed. Every branch on that number
 * lives in `catalog.service.ts`. That split is what makes the concurrency tests
 * readable — they call the repo directly and assert on `won`.
 *
 * Wire types stop at the door: ids are `number`, instants are `Date`, money and
 * the two measures stay decimal strings all the way down.
 */

// ---------------------------------------------------------------------------
// row shapes
// ---------------------------------------------------------------------------

export type CategoryRow = typeof productCategories.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type SkuRow = typeof productSkus.$inferSelect;
export type SpecRow = typeof productSpecs.$inferSelect;
export type SpecValueRow = typeof productSpecValues.$inferSelect;
export type LabelRow = typeof productLabels.$inferSelect;
export type LabelCategoryRow = typeof productLabelCategories.$inferSelect;
export type ParamTemplateRow = typeof productParamTemplates.$inferSelect;
export type ParamRow = typeof productParams.$inferSelect;
export type ProtectionRow = typeof productProtections.$inferSelect;
export type ReviewRow = typeof productReviews.$inferSelect;
export type VirtualCardRow = typeof productVirtualCards.$inferSelect;

export type ProductStatusValue = ProductRow['status'];
export type ProductKindValue = ProductRow['kind'];
export type ReviewStatusValue = ReviewRow['status'];
export type CardStateValue = VirtualCardRow['state'];

const liveCategory = (): SQL | undefined => isNull(productCategories.deletedAt);
const liveProduct = (): SQL | undefined => isNull(products.deletedAt);
const liveLabel = (): SQL | undefined => isNull(productLabels.deletedAt);
const liveReview = (): SQL | undefined => isNull(productReviews.deletedAt);

const count = sql<number>`count(*)::int`;

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

export async function findCategory(db: DbOrTx, id: number): Promise<CategoryRow | null> {
  const rows = await db
    .select()
    .from(productCategories)
    .where(and(eq(productCategories.id, id), liveCategory()))
    .limit(1);
  return rows[0] ?? null;
}

export interface CategoryListFilter {
  keyword?: string | undefined;
  parentId?: number | undefined;
  isVisible?: boolean | undefined;
  level?: number | undefined;
}

const CATEGORY_SORT = {
  id: productCategories.id,
  sortOrder: productCategories.sortOrder,
  name: productCategories.name,
  createdAt: productCategories.createdAt,
} as const;

export type CategorySortKey = keyof typeof CATEGORY_SORT;

export async function listCategories(
  db: DbOrTx,
  args: CategoryListFilter & {
    offset: number;
    limit: number;
    sortBy?: CategorySortKey | undefined;
    sortOrder?: 'asc' | 'desc' | undefined;
  },
): Promise<{ rows: CategoryRow[]; total: number }> {
  const where = allOf(
    liveCategory(),
    args.keyword ? sql`${productCategories.name} ilike ${likePattern(args.keyword)}` : undefined,
    args.parentId !== undefined ? eq(productCategories.parentId, args.parentId) : undefined,
    args.isVisible !== undefined ? eq(productCategories.isVisible, args.isVisible) : undefined,
    args.level !== undefined ? eq(productCategories.level, args.level) : undefined,
  );
  const column = CATEGORY_SORT[args.sortBy ?? 'sortOrder'];
  const direction = args.sortOrder === 'desc' ? desc : asc;

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(productCategories)
      .where(where)
      // `id` last so the order is total: two categories with the same
      // `sortOrder` must not swap places between pages.
      .orderBy(direction(column), asc(productCategories.id))
      .offset(args.offset)
      .limit(args.limit),
    db.select({ total: count }).from(productCategories).where(where),
  ]);
  return { rows, total: counted[0]?.total ?? 0 };
}

/** Every live category, for building the tree in memory. Capped at three levels by the service. */
export async function listAllCategories(
  db: DbOrTx,
  args: { visibleOnly: boolean },
): Promise<CategoryRow[]> {
  return db
    .select()
    .from(productCategories)
    .where(
      allOf(liveCategory(), args.visibleOnly ? eq(productCategories.isVisible, true) : undefined),
    )
    .orderBy(
      asc(productCategories.level),
      asc(productCategories.sortOrder),
      asc(productCategories.id),
    );
}

/**
 * `category_id -> live products mapped to it`, for the 商品数 column.
 *
 * One grouped query whatever the page size. Counts the *direct* mapping only:
 * a product in 男装/T恤 is mapped to both rows by the product service, so a
 * recursive count would double it.
 */
export async function categoryProductCounts(
  db: DbOrTx,
  categoryIds: readonly number[],
): Promise<Map<number, number>> {
  if (categoryIds.length === 0) return new Map();
  const rows = await db
    .select({ categoryId: productCategoriesMap.categoryId, total: count })
    .from(productCategoriesMap)
    .innerJoin(products, eq(products.id, productCategoriesMap.productId))
    .where(and(inArray(productCategoriesMap.categoryId, [...categoryIds]), liveProduct()))
    .groupBy(productCategoriesMap.categoryId);
  return new Map(rows.map((r) => [r.categoryId, r.total]));
}

export type NewCategoryValues = typeof productCategories.$inferInsert;

export async function insertCategory(tx: Tx, values: NewCategoryValues): Promise<CategoryRow> {
  const rows = await tx.insert(productCategories).values(values).returning();
  return rows[0]!;
}

export async function updateCategory(
  tx: Tx,
  id: number,
  values: Partial<NewCategoryValues>,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productCategories, {
    where: and(eq(productCategories.id, id), liveCategory()),
    set: values,
  });
}

/** The list's 显示 switch, guarded on the value it moves *from*. */
export async function setCategoryVisibility(
  tx: Tx,
  args: { id: number; from: boolean; to: boolean; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productCategories, {
    where: and(
      eq(productCategories.id, args.id),
      eq(productCategories.isVisible, args.from),
      liveCategory(),
    ),
    set: { isVisible: args.to, updatedAt: args.now },
  });
}

export async function softDeleteCategory(
  tx: Tx,
  args: { id: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productCategories, {
    where: and(eq(productCategories.id, args.id), liveCategory()),
    set: { deletedAt: args.now, updatedAt: args.now },
  });
}

export async function countLiveChildren(db: DbOrTx, categoryId: number): Promise<number> {
  const rows = await db
    .select({ total: count })
    .from(productCategories)
    .where(and(eq(productCategories.parentId, categoryId), liveCategory()));
  return rows[0]?.total ?? 0;
}

export async function countCategoryProducts(db: DbOrTx, categoryId: number): Promise<number> {
  const counts = await categoryProductCounts(db, [categoryId]);
  return counts.get(categoryId) ?? 0;
}

/**
 * Rewrite the materialised paths of a moved subtree, in one statement.
 *
 * `path` is a prefix, so a move is `replace(path, oldPrefix, newPrefix)` over
 * every row whose path starts with the old one; `level` shifts by the depth
 * difference. Doing this row by row risks a half-finished move that leaves
 * orphans whose parent chain no longer resolves.
 */
export async function moveSubtree(
  tx: Tx,
  args: { oldPrefix: string; newPrefix: string; levelDelta: number; now: Date },
): Promise<number> {
  if (args.oldPrefix === args.newPrefix && args.levelDelta === 0) return 0;
  const { affected } = await conditionalUpdate(tx, productCategories, {
    where: and(sql`${productCategories.path} like ${`${args.oldPrefix}%`}`, liveCategory()),
    set: {
      path: sql`overlay(${productCategories.path} placing ${args.newPrefix} from 1 for ${args.oldPrefix.length})`,
      level: sql`${productCategories.level} + ${args.levelDelta}`,
      updatedAt: args.now,
    },
  });
  return affected;
}

/**
 * A cheap version token for the storefront tree (its `version` and `ETag`).
 *
 * A client refetches only when this moves. It is derived
 * rather than a key an operator has to remember to bump: newest update plus row
 * count, so any insert, edit or delete changes it and nothing has to be
 * maintained.
 */
export async function categoryVersion(db: DbOrTx): Promise<string> {
  const rows = await db
    .select({
      newest: sql<Date | null>`max(${productCategories.updatedAt})`,
      total: count,
    })
    .from(productCategories)
    .where(and(liveCategory(), eq(productCategories.isVisible, true)));
  const row = rows[0];
  const stamp = row?.newest ? new Date(row.newest).getTime() : 0;
  return `${Math.floor(stamp / 1000)}-${row?.total ?? 0}`;
}

/** Which of these category ids exist and are live. The product form refuses the whole save if any is not. */
export async function existingCategoryIds(
  db: DbOrTx,
  ids: readonly number[],
): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: productCategories.id })
    .from(productCategories)
    .where(and(inArray(productCategories.id, [...ids]), liveCategory()));
  return new Set(rows.map((r) => r.id));
}

export async function categoryNames(
  db: DbOrTx,
  ids: readonly number[],
): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: productCategories.id, name: productCategories.name })
    .from(productCategories)
    .where(inArray(productCategories.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ---------------------------------------------------------------------------
// products — reads
// ---------------------------------------------------------------------------

export async function findProduct(
  db: DbOrTx,
  id: number,
  options: { includeDeleted?: boolean } = {},
): Promise<ProductRow | null> {
  const rows = await db
    .select()
    .from(products)
    .where(allOf(eq(products.id, id), options.includeDeleted ? undefined : liveProduct()))
    .limit(1);
  return rows[0] ?? null;
}

/** The storefront read: on the shelf, not deleted. Nothing else may be shown or sold. */
export async function findSellableProduct(db: DbOrTx, id: number): Promise<ProductRow | null> {
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.id, id), eq(products.status, 'on_shelf'), liveProduct()))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * `not_on_shelf` is the phone's 仓库中 and has no console tab.
 *
 * The console separates "taken off the shelf" from "never published" because an
 * operator building a catalogue cares about the difference; the phone's
 * 商家管理 has one `is_show` switch and four tabs, so its 仓库中 is everything
 * live that is not on sale. Without it a draft would be reachable from the
 * phone's 全部 tab and from nowhere else.
 */
export type ProductTab =
  | 'all'
  | 'on_shelf'
  | 'off_shelf'
  | 'not_on_shelf'
  | 'draft'
  | 'sold_out'
  | 'stock_warning'
  | 'deleted';

export interface ProductListFilter {
  tab: ProductTab;
  keyword?: string | undefined;
  categoryId?: number | undefined;
  labelId?: number | undefined;
  /** Only these products; the list then comes back in this order. */
  ids?: readonly number[] | undefined;
  kind?: ProductKindValue | undefined;
  priceFrom?: string | undefined;
  priceTo?: string | undefined;
  /** Used by the `stock_warning` tab. */
  stockThreshold?: number | undefined;
}

const PRODUCT_SORT = {
  id: products.id,
  price: products.price,
  stock: products.stock,
  sales: products.sales,
  sortOrder: products.sortOrder,
  createdAt: products.createdAt,
} as const;

export type ProductSortKey = keyof typeof PRODUCT_SORT;

function productWhere(filter: ProductListFilter): SQL | undefined {
  const tabCondition =
    filter.tab === 'deleted'
      ? isNotNull(products.deletedAt)
      : filter.tab === 'on_shelf'
        ? and(eq(products.status, 'on_shelf'), liveProduct())
        : filter.tab === 'off_shelf'
          ? and(eq(products.status, 'off_shelf'), liveProduct())
          : filter.tab === 'not_on_shelf'
            ? and(inArray(products.status, ['off_shelf', 'draft']), liveProduct())
            : filter.tab === 'draft'
              ? and(eq(products.status, 'draft'), liveProduct())
              : filter.tab === 'sold_out'
                ? and(eq(products.stock, 0), liveProduct())
                : filter.tab === 'stock_warning'
                  ? and(
                      lte(products.stock, filter.stockThreshold ?? 0),
                      gt(products.stock, 0),
                      liveProduct(),
                    )
                  : liveProduct();

  return allOf(
    tabCondition,
    filter.keyword
      ? or(
          sql`${products.name} ilike ${likePattern(filter.keyword)}`,
          sql`${products.keyword} ilike ${likePattern(filter.keyword)}`,
          sql`${products.spu} ilike ${likePattern(filter.keyword)}`,
        )
      : undefined,
    filter.kind ? eq(products.kind, filter.kind) : undefined,
    filter.priceFrom ? gte(products.price, filter.priceFrom) : undefined,
    filter.priceTo ? lte(products.price, filter.priceTo) : undefined,
    filter.categoryId !== undefined
      ? sql`exists (select 1 from ${productCategoriesMap} m where m.product_id = ${products.id} and m.category_id = ${filter.categoryId})`
      : undefined,
    filter.labelId !== undefined
      ? sql`exists (select 1 from ${productLabelsMap} l where l.product_id = ${products.id} and l.label_id = ${filter.labelId})`
      : undefined,
    filter.ids !== undefined ? inArray(products.id, [...filter.ids]) : undefined,
  );
}

export async function listProducts(
  db: DbOrTx,
  args: ProductListFilter & {
    offset: number;
    limit: number;
    sortBy?: ProductSortKey | undefined;
    sortOrder?: 'asc' | 'desc' | undefined;
  },
): Promise<{ rows: ProductRow[]; total: number }> {
  const where = productWhere(args);
  const column = PRODUCT_SORT[args.sortBy ?? 'id'];
  const direction = args.sortOrder === 'asc' ? asc : desc;
  // An id list is its own order: the caller stored these, in this sequence.
  const order =
    args.ids !== undefined
      ? [sql`array_position(${sql.param([...args.ids])}::bigint[], ${products.id})`]
      : [direction(column), desc(products.id)];

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(products)
      .where(where)
      .orderBy(...order)
      .offset(args.offset)
      .limit(args.limit),
    db.select({ total: count }).from(products).where(where),
  ]);
  return { rows, total: counted[0]?.total ?? 0 };
}

export interface StorefrontProductFilter {
  keyword?: string | undefined;
  categoryId?: number | undefined;
  labelId?: number | undefined;
  /** Only these products; the list then comes back in this order. */
  ids?: readonly number[] | undefined;
  /** In any of these categories. */
  categoryIds?: readonly number[] | undefined;
  /** Carrying any of these labels. */
  labelIds?: readonly number[] | undefined;
  priceFrom?: string | undefined;
  priceTo?: string | undefined;
  feature?: 'hot' | 'new' | 'best' | 'benefit' | 'recommended' | undefined;
  /**
   * A coupon's 指定商品 or 品类 scope (a shop-wide coupon passes none): named, or
   * filed directly under one of the categories — the rows the checkout reads.
   * Unlike `ids`, it does not set the order.
   */
  couponScope?: { productIds: readonly number[] } | { categoryIds: readonly number[] } | undefined;
}

const FEATURE_COLUMN = {
  hot: products.isHot,
  new: products.isNew,
  best: products.isBest,
  benefit: products.isBenefit,
  recommended: products.isRecommended,
} as const;

/**
 * The shopper's list.
 *
 * `status = 'on_shelf' AND deleted_at IS NULL` is not optional and is not the
 * caller's job: taking a product off the shelf must hide it everywhere, at
 * once, and this function being unable to return one is half of that promise
 * (the other half is `findSellableProduct`, which the stock reservation goes
 * through).
 *
 * Search is `ILIKE '%…%'` over `name` and `keyword`, which the two `gin_trgm_ops`
 * indexes serve. Case-insensitive and substring by construction, and correct
 * for Chinese because trigrams do not care about word boundaries.
 */
export async function listSellableProducts(
  db: DbOrTx,
  args: StorefrontProductFilter & {
    offset: number;
    limit: number;
    sortBy?: 'price' | 'sales' | 'createdAt' | undefined;
    sortOrder?: 'asc' | 'desc' | undefined;
  },
): Promise<{ rows: ProductRow[]; total: number }> {
  const where = allOf(
    eq(products.status, 'on_shelf'),
    liveProduct(),
    args.keyword
      ? or(
          sql`${products.name} ilike ${likePattern(args.keyword)}`,
          sql`${products.keyword} ilike ${likePattern(args.keyword)}`,
        )
      : undefined,
    args.priceFrom ? gte(products.price, args.priceFrom) : undefined,
    args.priceTo ? lte(products.price, args.priceTo) : undefined,
    args.feature ? eq(FEATURE_COLUMN[args.feature], true) : undefined,
    args.categoryId !== undefined
      ? sql`exists (select 1 from ${productCategoriesMap} m where m.product_id = ${products.id} and m.category_id = ${args.categoryId})`
      : undefined,
    args.labelId !== undefined
      ? sql`exists (select 1 from ${productLabelsMap} l where l.product_id = ${products.id} and l.label_id = ${args.labelId})`
      : undefined,
    args.ids !== undefined ? inArray(products.id, [...args.ids]) : undefined,
    args.categoryIds !== undefined
      ? sql`exists (select 1 from ${productCategoriesMap} m where m.product_id = ${products.id} and m.category_id = any(${sql.param([...args.categoryIds])}::bigint[]))`
      : undefined,
    args.labelIds !== undefined
      ? sql`exists (select 1 from ${productLabelsMap} l where l.product_id = ${products.id} and l.label_id = any(${sql.param([...args.labelIds])}::bigint[]))`
      : undefined,
    args.couponScope === undefined
      ? undefined
      : 'productIds' in args.couponScope
        ? sql`${products.id} = any(${sql.param([...args.couponScope.productIds])}::bigint[])`
        : sql`exists (select 1 from ${productCategoriesMap} m where m.product_id = ${products.id} and m.category_id = any(${sql.param([...args.couponScope.categoryIds])}::bigint[]))`,
  );

  const column =
    args.sortBy === 'price'
      ? products.price
      : args.sortBy === 'sales'
        ? products.sales
        : args.sortBy === 'createdAt'
          ? products.createdAt
          : products.sortOrder;
  const direction = args.sortOrder === 'asc' ? asc : desc;
  // An id list is its own order: the caller picked these, in this sequence.
  const order =
    args.ids !== undefined
      ? [sql`array_position(${sql.param([...args.ids])}::bigint[], ${products.id})`]
      : [direction(column), desc(products.id)];

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(products)
      .where(where)
      .orderBy(...order)
      .offset(args.offset)
      .limit(args.limit),
    db.select({ total: count }).from(products).where(where),
  ]);
  return { rows, total: counted[0]?.total ?? 0 };
}

/** Sellable products by id, in one statement, for the favourites and footprint lists. */
export async function findSellableProducts(
  db: DbOrTx,
  ids: readonly number[],
): Promise<Map<number, ProductRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(products)
    .where(and(inArray(products.id, [...ids]), eq(products.status, 'on_shelf'), liveProduct()));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function productsByIds(
  db: DbOrTx,
  ids: readonly number[],
): Promise<Map<number, ProductRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(products)
    .where(inArray(products.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r]));
}

/** `products_spu_uq` is a real index; this is the friendly check that turns it into a field error. */
export async function spuTakenBy(
  db: DbOrTx,
  args: { spu: string; exceptProductId?: number | undefined },
): Promise<number | null> {
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(
      allOf(
        eq(products.spu, args.spu),
        args.exceptProductId !== undefined ? ne(products.id, args.exceptProductId) : undefined,
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// products — writes
// ---------------------------------------------------------------------------

export type NewProductValues = typeof products.$inferInsert;

export async function insertProduct(tx: Tx, values: NewProductValues): Promise<ProductRow> {
  const rows = await tx.insert(products).values(values).returning();
  return rows[0]!;
}

export async function updateProduct(
  tx: Tx,
  id: number,
  values: Partial<NewProductValues>,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, products, {
    where: and(eq(products.id, id), liveProduct()),
    set: values,
  });
}

/**
 * 上架 / 下架, guarded on the status it moves *from*.
 *
 * Two operators clicking the switch at the same instant must not both report
 * success, and — more importantly — the storefront reads all filter on this
 * column, so the moment this commits the product is gone from every list and
 * every reservation.
 */
export async function setProductStatus(
  tx: Tx,
  args: {
    id: number;
    from: readonly ProductStatusValue[];
    to: ProductStatusValue;
    now: Date;
  },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, products, {
    where: and(eq(products.id, args.id), inArray(products.status, [...args.from]), liveProduct()),
    set: { status: args.to, updatedAt: args.now },
  });
}

export async function softDeleteProduct(
  tx: Tx,
  args: { id: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, products, {
    where: and(eq(products.id, args.id), liveProduct()),
    set: { deletedAt: args.now, updatedAt: args.now },
  });
}

/**
 * Out of the recycle bin.
 *
 * Comes back `off_shelf`, never straight to `on_shelf`: an operator decides
 * when a resurrected product is visible again. `deleted_at is not null` in the
 * WHERE is what makes a double-click a no-op rather than a silent re-publish.
 */
export async function restoreProduct(
  tx: Tx,
  args: { id: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, products, {
    where: and(eq(products.id, args.id), isNotNull(products.deletedAt)),
    set: { deletedAt: null, status: 'off_shelf', updatedAt: args.now },
  });
}

/**
 * The newest `product_events` id recorded at least `graceMs` ago, by the
 * database's clock — the one `created_at` defaults from — or `null` when there
 * is none. The view fold stops here, so an insert whose id was handed out but
 * whose transaction has not committed yet is never stepped over.
 */
export async function lastSettledEventId(db: DbOrTx, graceMs: number): Promise<number | null> {
  const [row] = await db
    .select({ id: productEvents.id })
    .from(productEvents)
    .where(lte(productEvents.createdAt, sql`now() - (${graceMs}::int * interval '1 millisecond')`))
    .orderBy(desc(productEvents.createdAt), desc(productEvents.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Folds the view events in `(afterId, throughId]` into `products.views`: one
 * `UPDATE … FROM (SELECT product_id, count(*) …)`, each product row touched
 * once per batch rather than once per view, so a busy product's row is not a
 * lock every page view queues on.
 */
export async function foldViewEvents(
  tx: Tx,
  range: { afterId: number; throughId: number },
): Promise<{ products: number; views: number }> {
  const result = await tx.execute<{ products: number; views: number }>(sql`
    with counted as (
      select ${productEvents.productId} as product_id, count(*)::int as n
      from ${productEvents}
      where ${productEvents.kind} = 'view'
        and ${productEvents.id} > ${range.afterId}
        and ${productEvents.id} <= ${range.throughId}
      group by ${productEvents.productId}
    ), folded as (
      update ${products} set views = ${products.views} + counted.n
      from counted
      where ${products.id} = counted.product_id
      returning counted.n
    )
    select count(*)::int as products, coalesce(sum(n), 0)::int as views from folded`);
  const row = result.rows[0];
  return { products: Number(row?.products ?? 0), views: Number(row?.views ?? 0) };
}

// ---------------------------------------------------------------------------
// link tables
// ---------------------------------------------------------------------------

/** Replaces a link list wholesale. Cheaper to reason about than a diff, and the rows are tiny. */
export async function replaceCategoryLinks(
  tx: Tx,
  productId: number,
  categoryIds: readonly number[],
): Promise<void> {
  await tx.delete(productCategoriesMap).where(eq(productCategoriesMap.productId, productId));
  const unique = [...new Set(categoryIds)];
  if (unique.length > 0) {
    await tx
      .insert(productCategoriesMap)
      .values(unique.map((categoryId) => ({ productId, categoryId })));
  }
}

export async function replaceLabelLinks(
  tx: Tx,
  productId: number,
  labelIds: readonly number[],
): Promise<void> {
  await tx.delete(productLabelsMap).where(eq(productLabelsMap.productId, productId));
  const unique = [...new Set(labelIds)];
  if (unique.length > 0) {
    await tx.insert(productLabelsMap).values(unique.map((labelId) => ({ productId, labelId })));
  }
}

export async function replaceProtectionLinks(
  tx: Tx,
  productId: number,
  protectionIds: readonly number[],
): Promise<void> {
  await tx.delete(productProtectionsMap).where(eq(productProtectionsMap.productId, productId));
  const unique = [...new Set(protectionIds)];
  if (unique.length > 0) {
    await tx
      .insert(productProtectionsMap)
      .values(unique.map((protectionId) => ({ productId, protectionId })));
  }
}

export async function replaceRecommendations(
  tx: Tx,
  productId: number,
  recommendedIds: readonly number[],
): Promise<void> {
  await tx.delete(productRecommendations).where(eq(productRecommendations.productId, productId));
  // `product_recommendations_not_self` would reject a self-reference; drop it
  // here so a careless paste is a quiet no-op rather than a 500.
  const unique = [...new Set(recommendedIds)].filter((id) => id !== productId);
  if (unique.length > 0) {
    await tx.insert(productRecommendations).values(
      unique.map((recommendedProductId, index) => ({
        productId,
        recommendedProductId,
        sortOrder: index,
      })),
    );
  }
}

/**
 * "Buy this, get that coupon."
 *
 * The table lives in `schema/coupon.ts` and its comment says the coupon domain
 * owns it, but the operator edits the link from the product page, so the rows
 * are written here and read by `coupon.listProductGiftTemplates`.
 */
export async function replaceGiftCoupons(
  tx: Tx,
  productId: number,
  templateIds: readonly number[],
): Promise<void> {
  await tx.delete(productGiftCoupons).where(eq(productGiftCoupons.productId, productId));
  const unique = [...new Set(templateIds)];
  if (unique.length > 0) {
    await tx
      .insert(productGiftCoupons)
      .values(unique.map((templateId, index) => ({ productId, templateId, sortOrder: index })));
  }
}

export async function linkedIds(
  db: DbOrTx,
  productId: number,
): Promise<{
  categoryIds: number[];
  labelIds: number[];
  protectionIds: number[];
  recommendedProductIds: number[];
  giftCouponIds: number[];
}> {
  const [categories, labels, protections, recommendations, gifts] = await Promise.all([
    db
      .select({ id: productCategoriesMap.categoryId })
      .from(productCategoriesMap)
      .where(eq(productCategoriesMap.productId, productId))
      .orderBy(asc(productCategoriesMap.categoryId)),
    db
      .select({ id: productLabelsMap.labelId })
      .from(productLabelsMap)
      .where(eq(productLabelsMap.productId, productId))
      .orderBy(asc(productLabelsMap.labelId)),
    db
      .select({ id: productProtectionsMap.protectionId })
      .from(productProtectionsMap)
      .where(eq(productProtectionsMap.productId, productId))
      .orderBy(asc(productProtectionsMap.protectionId)),
    db
      .select({ id: productRecommendations.recommendedProductId })
      .from(productRecommendations)
      .where(eq(productRecommendations.productId, productId))
      .orderBy(asc(productRecommendations.sortOrder)),
    db
      .select({ id: productGiftCoupons.templateId })
      .from(productGiftCoupons)
      .where(eq(productGiftCoupons.productId, productId))
      .orderBy(asc(productGiftCoupons.sortOrder)),
  ]);
  return {
    categoryIds: categories.map((r) => r.id),
    labelIds: labels.map((r) => r.id),
    protectionIds: protections.map((r) => r.id),
    recommendedProductIds: recommendations.map((r) => r.id),
    giftCouponIds: gifts.map((r) => r.id),
  };
}

/** `product_id -> category ids`, batched for a list page. */
export async function categoryIdsFor(
  db: DbOrTx,
  productIds: readonly number[],
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (productIds.length === 0) return out;
  const rows = await db
    .select({
      productId: productCategoriesMap.productId,
      categoryId: productCategoriesMap.categoryId,
    })
    .from(productCategoriesMap)
    .where(inArray(productCategoriesMap.productId, [...productIds]))
    .orderBy(asc(productCategoriesMap.categoryId));
  for (const row of rows) {
    const list = out.get(row.productId) ?? [];
    list.push(row.categoryId);
    out.set(row.productId, list);
  }
  return out;
}

/** `product_id -> visible, enabled labels`, batched. */
export async function labelsFor(
  db: DbOrTx,
  productIds: readonly number[],
): Promise<Map<number, LabelRow[]>> {
  const out = new Map<number, LabelRow[]>();
  if (productIds.length === 0) return out;
  const rows = await db
    .select({ productId: productLabelsMap.productId, label: productLabels })
    .from(productLabelsMap)
    .innerJoin(productLabels, eq(productLabels.id, productLabelsMap.labelId))
    .where(and(inArray(productLabelsMap.productId, [...productIds]), liveLabel()))
    .orderBy(asc(productLabels.sortOrder), asc(productLabels.id));
  for (const row of rows) {
    const list = out.get(row.productId) ?? [];
    list.push(row.label);
    out.set(row.productId, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// description and params
// ---------------------------------------------------------------------------

export async function upsertDescription(
  tx: Tx,
  args: { productId: number; contentHtml: string; now: Date },
): Promise<void> {
  await tx
    .insert(productDescriptions)
    .values({ productId: args.productId, contentHtml: args.contentHtml, updatedAt: args.now })
    .onConflictDoUpdate({
      target: productDescriptions.productId,
      set: { contentHtml: args.contentHtml, updatedAt: args.now },
    });
}

export async function findDescription(db: DbOrTx, productId: number): Promise<string> {
  const rows = await db
    .select({ contentHtml: productDescriptions.contentHtml })
    .from(productDescriptions)
    .where(eq(productDescriptions.productId, productId))
    .limit(1);
  return rows[0]?.contentHtml ?? '';
}

export async function replaceParams(
  tx: Tx,
  productId: number,
  params: readonly { name: string; value: string; templateId: number | null; sortOrder: number }[],
): Promise<void> {
  await tx.delete(productParams).where(eq(productParams.productId, productId));
  if (params.length === 0) return;
  // `product_params_name_uq (product_id, name)` — keep the first of a duplicate
  // name rather than letting the insert abort the whole save.
  const seen = new Set<string>();
  const values = params.filter((p) => !seen.has(p.name) && seen.add(p.name));
  await tx.insert(productParams).values(values.map((p) => ({ productId, ...p })));
}

export async function listParams(db: DbOrTx, productId: number): Promise<ParamRow[]> {
  return db
    .select()
    .from(productParams)
    .where(eq(productParams.productId, productId))
    .orderBy(asc(productParams.sortOrder), asc(productParams.id));
}

// ---------------------------------------------------------------------------
// specs
// ---------------------------------------------------------------------------

export async function listSpecs(
  db: DbOrTx,
  productId: number,
): Promise<{ spec: SpecRow; values: SpecValueRow[] }[]> {
  const specs = await db
    .select()
    .from(productSpecs)
    .where(eq(productSpecs.productId, productId))
    .orderBy(asc(productSpecs.sortOrder), asc(productSpecs.id));
  if (specs.length === 0) return [];
  const values = await db
    .select()
    .from(productSpecValues)
    .where(
      inArray(
        productSpecValues.specId,
        specs.map((s) => s.id),
      ),
    )
    .orderBy(asc(productSpecValues.sortOrder), asc(productSpecValues.id));
  return specs.map((spec) => ({
    spec,
    values: values.filter((v) => v.specId === spec.id),
  }));
}

/**
 * Replace the spec axes wholesale.
 *
 * Specs are presentation: the buyable thing is the SKU, which is matched by
 * `specText` and survives this. `ON DELETE CASCADE` takes the values with the
 * axis.
 */
export async function replaceSpecs(
  tx: Tx,
  productId: number,
  specs: readonly { name: string; values: readonly { value: string; imageUrl: string | null }[] }[],
): Promise<void> {
  await tx.delete(productSpecs).where(eq(productSpecs.productId, productId));
  for (const [index, spec] of specs.entries()) {
    const inserted = await tx
      .insert(productSpecs)
      .values({ productId, name: spec.name, sortOrder: index })
      .returning({ id: productSpecs.id });
    const specId = inserted[0]!.id;
    if (spec.values.length === 0) continue;
    await tx.insert(productSpecValues).values(
      spec.values.map((v, valueIndex) => ({
        specId,
        value: v.value,
        imageUrl: v.imageUrl,
        sortOrder: valueIndex,
      })),
    );
  }
}

// ---------------------------------------------------------------------------
// SKUs
// ---------------------------------------------------------------------------

export async function listSkus(db: DbOrTx, productId: number): Promise<SkuRow[]> {
  return db
    .select()
    .from(productSkus)
    .where(eq(productSkus.productId, productId))
    .orderBy(asc(productSkus.sortOrder), asc(productSkus.id));
}

export async function listVisibleSkus(db: DbOrTx, productId: number): Promise<SkuRow[]> {
  return db
    .select()
    .from(productSkus)
    .where(and(eq(productSkus.productId, productId), eq(productSkus.isVisible, true)))
    .orderBy(asc(productSkus.sortOrder), asc(productSkus.id));
}

export async function findSku(db: DbOrTx, id: number): Promise<SkuRow | null> {
  const rows = await db.select().from(productSkus).where(eq(productSkus.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findSkuByCode(db: DbOrTx, skuCode: string): Promise<SkuRow | null> {
  const rows = await db.select().from(productSkus).where(eq(productSkus.skuCode, skuCode)).limit(1);
  return rows[0] ?? null;
}

export async function skusByIds(db: DbOrTx, ids: readonly number[]): Promise<Map<number, SkuRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(productSkus)
    .where(inArray(productSkus.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r]));
}

export type NewSkuValues = typeof productSkus.$inferInsert;

export async function insertSku(tx: Tx, values: NewSkuValues): Promise<SkuRow> {
  const rows = await tx.insert(productSkus).values(values).returning();
  return rows[0]!;
}

export async function updateSku(
  tx: Tx,
  id: number,
  values: Partial<NewSkuValues>,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productSkus, { where: eq(productSkus.id, id), set: values });
}

/** Sets `stock` only if the row still holds `expected`. */
export async function setSkuStockIf(
  tx: Tx,
  args: { id: number; expected: number; next: number },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productSkus, {
    where: and(eq(productSkus.id, args.id), eq(productSkus.stock, args.expected)),
    set: { stock: args.next },
  });
}

export async function deleteSkus(tx: Tx, ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const deleted = await tx
    .delete(productSkus)
    .where(inArray(productSkus.id, [...ids]))
    .returning({ id: productSkus.id });
  return deleted.length;
}

/**
 * **The** conditional update of this domain: take `quantity` off a SKU.
 *
 * `stock >= quantity` in the WHERE clause is what makes overselling impossible,
 * and `product_skus_stock_non_negative` is the backstop that turns a future
 * mistake into a constraint violation rather than a negative counter. The
 * product-level `stock` column is denormalised alongside in the same
 * transaction.
 *
 * Reading the row, comparing in application code and then writing would let two
 * buyers take the last unit. STOCK-003 is this statement.
 */
export async function reserveSkuStock(
  tx: Tx,
  args: { skuId: number; quantity: number },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productSkus, {
    where: and(eq(productSkus.id, args.skuId), gte(productSkus.stock, args.quantity)),
    set: { stock: sql`${productSkus.stock} - ${args.quantity}` },
  });
}

/** Hand stock back. Unconditional by design: a release must never fail to restore. */
export async function releaseSkuStock(
  tx: Tx,
  args: { skuId: number; quantity: number },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productSkus, {
    where: eq(productSkus.id, args.skuId),
    set: { stock: sql`${productSkus.stock} + ${args.quantity}` },
  });
}

/**
 * Turn a reservation into a sale: stock stays down, `sales` goes up.
 *
 * One statement, so the counter cannot drift from the stock it belongs to.
 */
export async function commitSkuSale(
  tx: Tx,
  args: { skuId: number; quantity: number },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productSkus, {
    where: eq(productSkus.id, args.skuId),
    set: { sales: sql`${productSkus.sales} + ${args.quantity}` },
  });
}

/**
 * The refund path: stock back **and** `sales` down, in one statement.
 *
 * `greatest(0, …)` rather than a bare subtraction:
 * `product_skus_sales_non_negative` would abort the whole refund transaction if
 * two releases raced past zero, and an over-released counter is a reporting
 * inaccuracy while a failed refund is a customer with no money.
 */
export async function releaseSoldSkuStock(
  tx: Tx,
  args: { skuId: number; quantity: number },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productSkus, {
    where: eq(productSkus.id, args.skuId),
    set: {
      stock: sql`${productSkus.stock} + ${args.quantity}`,
      sales: sql`greatest(0, ${productSkus.sales} - ${args.quantity})`,
    },
  });
}

/**
 * Recompute the denormalised `products.price/cost/stock/sales` from the SKUs.
 *
 * One statement with sub-selects rather than a read in the service: the values
 * are derived, so they must be derived from what is committed at this instant,
 * not from what the service read a moment ago. Runs after every stock movement
 * and every product save.
 */
export async function rollupProduct(tx: Tx, productId: number): Promise<void> {
  await tx
    .update(products)
    .set({
      price: sql`coalesce((select min(s.price) from ${productSkus} s where s.product_id = ${productId} and s.is_visible), 0)`,
      cost: sql`(select min(s.cost) from ${productSkus} s where s.product_id = ${productId} and s.is_visible)`,
      stock: sql`coalesce((select sum(s.stock) from ${productSkus} s where s.product_id = ${productId} and s.is_visible), 0)`,
      sales: sql`coalesce((select sum(s.sales) from ${productSkus} s where s.product_id = ${productId}), 0)`,
    })
    .where(eq(products.id, productId));
}

/** Every SKU at or below the warning threshold, with its product. */
export async function listStockWarnings(
  db: DbOrTx,
  args: {
    threshold: number;
    keyword?: string | undefined;
    categoryId?: number | undefined;
    offset: number;
    limit: number;
  },
): Promise<{ rows: { sku: SkuRow; product: ProductRow }[]; total: number }> {
  const where = allOf(
    lte(productSkus.stock, args.threshold),
    eq(productSkus.isVisible, true),
    liveProduct(),
    ne(products.status, 'draft'),
    args.keyword ? sql`${products.name} ilike ${likePattern(args.keyword)}` : undefined,
    args.categoryId !== undefined
      ? sql`exists (select 1 from ${productCategoriesMap} m where m.product_id = ${products.id} and m.category_id = ${args.categoryId})`
      : undefined,
  );

  const [rows, counted] = await Promise.all([
    db
      .select({ sku: productSkus, product: products })
      .from(productSkus)
      .innerJoin(products, eq(products.id, productSkus.productId))
      .where(where)
      .orderBy(asc(productSkus.stock), asc(productSkus.id))
      .offset(args.offset)
      .limit(args.limit),
    db
      .select({ total: count })
      .from(productSkus)
      .innerJoin(products, eq(products.id, productSkus.productId))
      .where(where),
  ]);
  return { rows, total: counted[0]?.total ?? 0 };
}

/** Every SKU of the filtered products, for the export. One query, not one per product. */
export async function listSkusForProducts(
  db: DbOrTx,
  productIds: readonly number[],
): Promise<Map<number, SkuRow[]>> {
  const out = new Map<number, SkuRow[]>();
  if (productIds.length === 0) return out;
  const rows = await db
    .select()
    .from(productSkus)
    .where(inArray(productSkus.productId, [...productIds]))
    .orderBy(asc(productSkus.productId), asc(productSkus.sortOrder), asc(productSkus.id));
  for (const row of rows) {
    const list = out.get(row.productId) ?? [];
    list.push(row);
    out.set(row.productId, list);
  }
  return out;
}

/**
 * Claim a once-per-order stock operation, returning `false` if it already ran.
 *
 * `StockPort`'s methods take `(tx, orderId, lines)` — no `ctx`, so no clock and
 * no `recordEffect` — yet the port doc requires them to be idempotent per order
 * because the effect ledger delivers at least once. The ledger's own
 * `UNIQUE (scope, scope_id, event_type)` is the only exactly-once mechanism in
 * the system, and SCHEMA.md §4.5 already reserves `catalog.stock.commit` and
 * `catalog.stock.release` as keys, so the guard is a row in that table.
 *
 * `status = 'done'` and `attempts = 1`: the row is a marker, not work. The
 * dispatcher looks for `status = 'pending'` and will never pick it up.
 * Timestamps come from the database default rather than a clock, because
 * nothing decides anything from them.
 *
 * The scope is the caller's choice and it is load-bearing. Cancel and commit
 * happen once per *order*, so they key on `('order', orderId)`. A refund does
 * not: an order is refunded line by line, so a refund release keys on
 * `('refund', refundId)` — a single per-order key would swallow the second
 * partial refund and leave that stock off the shelf forever.
 */
export async function claimStockOperation(
  tx: Tx,
  args: {
    scope: 'order' | 'refund';
    scopeId: number;
    eventType: 'catalog.stock.commit' | 'catalog.stock.release';
  },
): Promise<boolean> {
  const rows = await tx
    .insert(effects)
    .values({
      scope: args.scope,
      scopeId: String(args.scopeId),
      eventType: args.eventType,
      payload: {},
      status: 'done',
      attempts: 1,
    })
    .onConflictDoNothing()
    .returning({ id: effects.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// virtual cards
// ---------------------------------------------------------------------------

export type NewVirtualCardValues = typeof productVirtualCards.$inferInsert;

export async function insertVirtualCards(
  tx: Tx,
  values: readonly NewVirtualCardValues[],
): Promise<VirtualCardRow[]> {
  if (values.length === 0) return [];
  return tx
    .insert(productVirtualCards)
    .values([...values])
    .onConflictDoNothing()
    .returning();
}

/** Card numbers already in this SKU's pool, so an import can report duplicates rather than fail. */
export async function existingCardNos(
  db: DbOrTx,
  args: { skuId: number; cardNos: readonly string[] },
): Promise<Set<string>> {
  if (args.cardNos.length === 0) return new Set();
  const rows = await db
    .select({ cardNo: productVirtualCards.cardNo })
    .from(productVirtualCards)
    .where(
      and(
        eq(productVirtualCards.skuId, args.skuId),
        inArray(productVirtualCards.cardNo, [...args.cardNos]),
      ),
    );
  return new Set(rows.map((r) => r.cardNo));
}

export async function listVirtualCards(
  db: DbOrTx,
  args: {
    productId: number;
    skuId?: number | undefined;
    state?: CardStateValue | undefined;
    offset: number;
    limit: number;
  },
): Promise<{ rows: VirtualCardRow[]; total: number }> {
  const where = allOf(
    eq(productVirtualCards.productId, args.productId),
    args.skuId !== undefined ? eq(productVirtualCards.skuId, args.skuId) : undefined,
    args.state ? eq(productVirtualCards.state, args.state) : undefined,
  );
  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(productVirtualCards)
      .where(where)
      .orderBy(desc(productVirtualCards.id))
      .offset(args.offset)
      .limit(args.limit),
    db.select({ total: count }).from(productVirtualCards).where(where),
  ]);
  return { rows, total: counted[0]?.total ?? 0 };
}

/** Withdraw unclaimed cards. A claimed card is never voided: somebody is holding it. */
export async function voidVirtualCards(
  tx: Tx,
  args: { productId: number; cardIds: readonly number[]; now: Date },
): Promise<number> {
  if (args.cardIds.length === 0) return 0;
  const { affected } = await conditionalUpdate(tx, productVirtualCards, {
    where: and(
      eq(productVirtualCards.productId, args.productId),
      inArray(productVirtualCards.id, [...args.cardIds]),
      eq(productVirtualCards.state, 'unclaimed'),
    ),
    set: { state: 'void', updatedAt: args.now },
  });
  return affected;
}

export async function countUnclaimedCards(db: DbOrTx, skuId: number): Promise<number> {
  const rows = await db
    .select({ total: count })
    .from(productVirtualCards)
    .where(and(eq(productVirtualCards.skuId, skuId), eq(productVirtualCards.state, 'unclaimed')));
  return rows[0]?.total ?? 0;
}

/**
 * Set a card SKU's stock to the size of its unclaimed pool, in one statement.
 *
 * The pool *is* the stock for a `virtual_card` product; deriving it rather than
 * adding to it is what stops the two drifting — a drifted count sells cards
 * that do not exist.
 */
export async function syncCardStock(tx: Tx, skuId: number): Promise<number> {
  const rows = await tx
    .update(productSkus)
    .set({
      stock: sql`(select count(*)::int from ${productVirtualCards} c where c.sku_id = ${skuId} and c.state = 'unclaimed')`,
    })
    .where(eq(productSkus.id, skuId))
    .returning({ stock: productSkus.stock });
  return rows[0]?.stock ?? 0;
}

// ---------------------------------------------------------------------------
// labels, label categories, param templates, protections
// ---------------------------------------------------------------------------

export async function findLabel(db: DbOrTx, id: number): Promise<LabelRow | null> {
  const rows = await db
    .select()
    .from(productLabels)
    .where(and(eq(productLabels.id, id), liveLabel()))
    .limit(1);
  return rows[0] ?? null;
}

export async function existingLabelIds(db: DbOrTx, ids: readonly number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: productLabels.id })
    .from(productLabels)
    .where(and(inArray(productLabels.id, [...ids]), liveLabel()));
  return new Set(rows.map((r) => r.id));
}

export async function listLabels(
  db: DbOrTx,
  args: {
    keyword?: string | undefined;
    categoryId?: number | undefined;
    isEnabled?: boolean | undefined;
    offset: number;
    limit: number;
    sortBy?: 'id' | 'sortOrder' | 'name' | 'createdAt' | undefined;
    sortOrder?: 'asc' | 'desc' | undefined;
  },
): Promise<{ rows: { label: LabelRow; categoryName: string | null }[]; total: number }> {
  const where = allOf(
    liveLabel(),
    args.keyword ? sql`${productLabels.name} ilike ${likePattern(args.keyword)}` : undefined,
    args.categoryId !== undefined ? eq(productLabels.categoryId, args.categoryId) : undefined,
    args.isEnabled !== undefined ? eq(productLabels.isEnabled, args.isEnabled) : undefined,
  );
  const column = {
    id: productLabels.id,
    sortOrder: productLabels.sortOrder,
    name: productLabels.name,
    createdAt: productLabels.createdAt,
  }[args.sortBy ?? 'sortOrder'];
  const direction = args.sortOrder === 'desc' ? desc : asc;

  const [rows, counted] = await Promise.all([
    db
      .select({ label: productLabels, categoryName: productLabelCategories.name })
      .from(productLabels)
      .leftJoin(productLabelCategories, eq(productLabelCategories.id, productLabels.categoryId))
      .where(where)
      .orderBy(direction(column), asc(productLabels.id))
      .offset(args.offset)
      .limit(args.limit),
    db.select({ total: count }).from(productLabels).where(where),
  ]);
  return { rows, total: counted[0]?.total ?? 0 };
}

export async function labelProductCounts(
  db: DbOrTx,
  labelIds: readonly number[],
): Promise<Map<number, number>> {
  if (labelIds.length === 0) return new Map();
  const rows = await db
    .select({ labelId: productLabelsMap.labelId, total: count })
    .from(productLabelsMap)
    .innerJoin(products, eq(products.id, productLabelsMap.productId))
    .where(and(inArray(productLabelsMap.labelId, [...labelIds]), liveProduct()))
    .groupBy(productLabelsMap.labelId);
  return new Map(rows.map((r) => [r.labelId, r.total]));
}

export type NewLabelValues = typeof productLabels.$inferInsert;

export async function insertLabel(tx: Tx, values: NewLabelValues): Promise<LabelRow> {
  const rows = await tx.insert(productLabels).values(values).returning();
  return rows[0]!;
}

export async function updateLabel(
  tx: Tx,
  id: number,
  values: Partial<NewLabelValues>,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productLabels, {
    where: and(eq(productLabels.id, id), liveLabel()),
    set: values,
  });
}

export async function setLabelEnabled(
  tx: Tx,
  args: { id: number; from: boolean; to: boolean; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productLabels, {
    where: and(eq(productLabels.id, args.id), eq(productLabels.isEnabled, args.from), liveLabel()),
    set: { isEnabled: args.to, updatedAt: args.now },
  });
}

export async function softDeleteLabel(
  tx: Tx,
  args: { id: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productLabels, {
    where: and(eq(productLabels.id, args.id), liveLabel()),
    set: { deletedAt: args.now, updatedAt: args.now },
  });
}

export async function labelNameTakenBy(
  db: DbOrTx,
  args: { name: string; exceptId?: number | undefined },
): Promise<number | null> {
  const rows = await db
    .select({ id: productLabels.id })
    .from(productLabels)
    .where(
      allOf(
        eq(productLabels.name, args.name),
        args.exceptId !== undefined ? ne(productLabels.id, args.exceptId) : undefined,
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function findLabelCategory(db: DbOrTx, id: number): Promise<LabelCategoryRow | null> {
  const rows = await db
    .select()
    .from(productLabelCategories)
    .where(and(eq(productLabelCategories.id, id), isNull(productLabelCategories.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listLabelCategories(
  db: DbOrTx,
  args: {
    keyword?: string | undefined;
    offset: number;
    limit: number;
    sortBy?: 'id' | 'sortOrder' | 'name' | undefined;
    sortOrder?: 'asc' | 'desc' | undefined;
  },
): Promise<{ rows: LabelCategoryRow[]; total: number }> {
  const where = allOf(
    isNull(productLabelCategories.deletedAt),
    args.keyword
      ? sql`${productLabelCategories.name} ilike ${likePattern(args.keyword)}`
      : undefined,
  );
  const column = {
    id: productLabelCategories.id,
    sortOrder: productLabelCategories.sortOrder,
    name: productLabelCategories.name,
  }[args.sortBy ?? 'sortOrder'];
  const direction = args.sortOrder === 'desc' ? desc : asc;

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(productLabelCategories)
      .where(where)
      .orderBy(direction(column), asc(productLabelCategories.id))
      .offset(args.offset)
      .limit(args.limit),
    db.select({ total: count }).from(productLabelCategories).where(where),
  ]);
  return { rows, total: counted[0]?.total ?? 0 };
}

export async function labelCategoryCounts(
  db: DbOrTx,
  ids: readonly number[],
): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ categoryId: productLabels.categoryId, total: count })
    .from(productLabels)
    .where(and(inArray(productLabels.categoryId, [...ids]), liveLabel()))
    .groupBy(productLabels.categoryId);
  return new Map(rows.filter((r) => r.categoryId !== null).map((r) => [r.categoryId!, r.total]));
}

export type NewLabelCategoryValues = typeof productLabelCategories.$inferInsert;

export async function insertLabelCategory(
  tx: Tx,
  values: NewLabelCategoryValues,
): Promise<LabelCategoryRow> {
  const rows = await tx.insert(productLabelCategories).values(values).returning();
  return rows[0]!;
}

export async function updateLabelCategory(
  tx: Tx,
  id: number,
  values: Partial<NewLabelCategoryValues>,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productLabelCategories, {
    where: and(eq(productLabelCategories.id, id), isNull(productLabelCategories.deletedAt)),
    set: values,
  });
}

export async function softDeleteLabelCategory(
  tx: Tx,
  args: { id: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productLabelCategories, {
    where: and(eq(productLabelCategories.id, args.id), isNull(productLabelCategories.deletedAt)),
    set: { deletedAt: args.now, updatedAt: args.now },
  });
}

/** Deleting a grouping must not delete the labels in it. */
export async function detachLabelsFromCategory(tx: Tx, categoryId: number): Promise<number> {
  const { affected } = await conditionalUpdate(tx, productLabels, {
    where: eq(productLabels.categoryId, categoryId),
    set: { categoryId: null },
  });
  return affected;
}

export async function labelCategoryNameTakenBy(
  db: DbOrTx,
  args: { name: string; exceptId?: number | undefined },
): Promise<number | null> {
  const rows = await db
    .select({ id: productLabelCategories.id })
    .from(productLabelCategories)
    .where(
      allOf(
        eq(productLabelCategories.name, args.name),
        args.exceptId !== undefined ? ne(productLabelCategories.id, args.exceptId) : undefined,
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

// --- param templates -------------------------------------------------------

export async function findParamTemplate(db: DbOrTx, id: number): Promise<ParamTemplateRow | null> {
  const rows = await db
    .select()
    .from(productParamTemplates)
    .where(and(eq(productParamTemplates.id, id), isNull(productParamTemplates.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listParamTemplates(
  db: DbOrTx,
  args: {
    keyword?: string | undefined;
    isEnabled?: boolean | undefined;
    offset: number;
    limit: number;
    sortBy?: 'id' | 'sortOrder' | 'name' | undefined;
    sortOrder?: 'asc' | 'desc' | undefined;
  },
): Promise<{ rows: ParamTemplateRow[]; total: number }> {
  const where = allOf(
    isNull(productParamTemplates.deletedAt),
    args.keyword
      ? sql`${productParamTemplates.name} ilike ${likePattern(args.keyword)}`
      : undefined,
    args.isEnabled !== undefined ? eq(productParamTemplates.isEnabled, args.isEnabled) : undefined,
  );
  const column = {
    id: productParamTemplates.id,
    sortOrder: productParamTemplates.sortOrder,
    name: productParamTemplates.name,
  }[args.sortBy ?? 'sortOrder'];
  const direction = args.sortOrder === 'desc' ? desc : asc;

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(productParamTemplates)
      .where(where)
      .orderBy(direction(column), asc(productParamTemplates.id))
      .offset(args.offset)
      .limit(args.limit),
    db.select({ total: count }).from(productParamTemplates).where(where),
  ]);
  return { rows, total: counted[0]?.total ?? 0 };
}

export type NewParamTemplateValues = typeof productParamTemplates.$inferInsert;

export async function insertParamTemplate(
  tx: Tx,
  values: NewParamTemplateValues,
): Promise<ParamTemplateRow> {
  const rows = await tx.insert(productParamTemplates).values(values).returning();
  return rows[0]!;
}

export async function updateParamTemplate(
  tx: Tx,
  id: number,
  values: Partial<NewParamTemplateValues>,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productParamTemplates, {
    where: and(eq(productParamTemplates.id, id), isNull(productParamTemplates.deletedAt)),
    set: values,
  });
}

export async function setParamTemplateEnabled(
  tx: Tx,
  args: { id: number; from: boolean; to: boolean; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productParamTemplates, {
    where: and(
      eq(productParamTemplates.id, args.id),
      eq(productParamTemplates.isEnabled, args.from),
      isNull(productParamTemplates.deletedAt),
    ),
    set: { isEnabled: args.to, updatedAt: args.now },
  });
}

export async function softDeleteParamTemplate(
  tx: Tx,
  args: { id: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productParamTemplates, {
    where: and(eq(productParamTemplates.id, args.id), isNull(productParamTemplates.deletedAt)),
    set: { deletedAt: args.now, updatedAt: args.now },
  });
}

export async function paramTemplateNameTakenBy(
  db: DbOrTx,
  args: { name: string; exceptId?: number | undefined },
): Promise<number | null> {
  const rows = await db
    .select({ id: productParamTemplates.id })
    .from(productParamTemplates)
    .where(
      allOf(
        eq(productParamTemplates.name, args.name),
        args.exceptId !== undefined ? ne(productParamTemplates.id, args.exceptId) : undefined,
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

// --- protections -----------------------------------------------------------

export async function findProtection(db: DbOrTx, id: number): Promise<ProtectionRow | null> {
  const rows = await db
    .select()
    .from(productProtections)
    .where(and(eq(productProtections.id, id), isNull(productProtections.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function existingProtectionIds(
  db: DbOrTx,
  ids: readonly number[],
): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: productProtections.id })
    .from(productProtections)
    .where(and(inArray(productProtections.id, [...ids]), isNull(productProtections.deletedAt)));
  return new Set(rows.map((r) => r.id));
}

export async function listProtections(
  db: DbOrTx,
  args: {
    keyword?: string | undefined;
    isEnabled?: boolean | undefined;
    offset: number;
    limit: number;
    sortBy?: 'id' | 'sortOrder' | 'title' | undefined;
    sortOrder?: 'asc' | 'desc' | undefined;
  },
): Promise<{ rows: ProtectionRow[]; total: number }> {
  const where = allOf(
    isNull(productProtections.deletedAt),
    args.keyword ? sql`${productProtections.title} ilike ${likePattern(args.keyword)}` : undefined,
    args.isEnabled !== undefined ? eq(productProtections.isEnabled, args.isEnabled) : undefined,
  );
  const column = {
    id: productProtections.id,
    sortOrder: productProtections.sortOrder,
    title: productProtections.title,
  }[args.sortBy ?? 'sortOrder'];
  const direction = args.sortOrder === 'desc' ? desc : asc;

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(productProtections)
      .where(where)
      .orderBy(direction(column), asc(productProtections.id))
      .offset(args.offset)
      .limit(args.limit),
    db.select({ total: count }).from(productProtections).where(where),
  ]);
  return { rows, total: counted[0]?.total ?? 0 };
}

export async function protectionsFor(db: DbOrTx, productId: number): Promise<ProtectionRow[]> {
  return db
    .select({ protection: productProtections })
    .from(productProtectionsMap)
    .innerJoin(productProtections, eq(productProtections.id, productProtectionsMap.protectionId))
    .where(
      and(
        eq(productProtectionsMap.productId, productId),
        eq(productProtections.isEnabled, true),
        isNull(productProtections.deletedAt),
      ),
    )
    .orderBy(asc(productProtections.sortOrder), asc(productProtections.id))
    .then((rows) => rows.map((r) => r.protection));
}

export type NewProtectionValues = typeof productProtections.$inferInsert;

export async function insertProtection(
  tx: Tx,
  values: NewProtectionValues,
): Promise<ProtectionRow> {
  const rows = await tx.insert(productProtections).values(values).returning();
  return rows[0]!;
}

export async function updateProtection(
  tx: Tx,
  id: number,
  values: Partial<NewProtectionValues>,
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productProtections, {
    where: and(eq(productProtections.id, id), isNull(productProtections.deletedAt)),
    set: values,
  });
}

export async function setProtectionEnabled(
  tx: Tx,
  args: { id: number; from: boolean; to: boolean; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productProtections, {
    where: and(
      eq(productProtections.id, args.id),
      eq(productProtections.isEnabled, args.from),
      isNull(productProtections.deletedAt),
    ),
    set: { isEnabled: args.to, updatedAt: args.now },
  });
}

export async function softDeleteProtection(
  tx: Tx,
  args: { id: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productProtections, {
    where: and(eq(productProtections.id, args.id), isNull(productProtections.deletedAt)),
    set: { deletedAt: args.now, updatedAt: args.now },
  });
}

export async function protectionTitleTakenBy(
  db: DbOrTx,
  args: { title: string; exceptId?: number | undefined },
): Promise<number | null> {
  const rows = await db
    .select({ id: productProtections.id })
    .from(productProtections)
    .where(
      allOf(
        eq(productProtections.title, args.title),
        args.exceptId !== undefined ? ne(productProtections.id, args.exceptId) : undefined,
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// favourites
// ---------------------------------------------------------------------------

/**
 * Idempotent by construction: the composite primary key plus
 * `ON CONFLICT DO NOTHING`. A double-tapped heart is one row, not a 409.
 */
export async function addFavorite(
  tx: Tx,
  args: { userId: number; productId: number },
): Promise<boolean> {
  const rows = await tx
    .insert(productFavorites)
    .values({ userId: args.userId, productId: args.productId })
    .onConflictDoNothing()
    .returning({ productId: productFavorites.productId });
  return rows.length > 0;
}

export async function removeFavorites(
  tx: Tx,
  args: { userId: number; productIds: readonly number[] },
): Promise<number> {
  if (args.productIds.length === 0) return 0;
  const rows = await tx
    .delete(productFavorites)
    .where(
      and(
        eq(productFavorites.userId, args.userId),
        inArray(productFavorites.productId, [...args.productIds]),
      ),
    )
    .returning({ productId: productFavorites.productId });
  return rows.length;
}

export async function listFavorites(
  db: DbOrTx,
  args: { userId: number; offset: number; limit: number },
): Promise<{ rows: { productId: number; createdAt: Date }[]; total: number }> {
  const where = eq(productFavorites.userId, args.userId);
  const [rows, counted] = await Promise.all([
    db
      .select({ productId: productFavorites.productId, createdAt: productFavorites.createdAt })
      .from(productFavorites)
      .where(where)
      .orderBy(desc(productFavorites.createdAt), desc(productFavorites.productId))
      .offset(args.offset)
      .limit(args.limit),
    db.select({ total: count }).from(productFavorites).where(where),
  ]);
  return { rows, total: counted[0]?.total ?? 0 };
}

export async function isFavorited(
  db: DbOrTx,
  args: { userId: number; productId: number },
): Promise<boolean> {
  const rows = await db
    .select({ productId: productFavorites.productId })
    .from(productFavorites)
    .where(
      and(eq(productFavorites.userId, args.userId), eq(productFavorites.productId, args.productId)),
    )
    .limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// reviews
// ---------------------------------------------------------------------------

export async function findReview(db: DbOrTx, id: number): Promise<ReviewRow | null> {
  const rows = await db
    .select()
    .from(productReviews)
    .where(and(eq(productReviews.id, id), liveReview()))
    .limit(1);
  return rows[0] ?? null;
}

export type NewReviewValues = typeof productReviews.$inferInsert;

/**
 * Insert a review, or `null` when `product_reviews_order_item_uq` refused it.
 *
 * `ON CONFLICT DO NOTHING` is the whole "one review per purchased line"
 * mechanism: two taps compute the same order item id and exactly one row
 * lands. The `null` is an expected outcome the service turns into
 * `CATALOG_REVIEW_ALREADY_WRITTEN` (409), never a 500.
 */
export async function insertReview(tx: Tx, values: NewReviewValues): Promise<ReviewRow | null> {
  const rows = await tx.insert(productReviews).values(values).onConflictDoNothing().returning();
  return rows[0] ?? null;
}

/**
 * Takes one picture off a review (内容安全 said `risky`, C09). `false` when the
 * picture was no longer on it — edited away, or the review deleted.
 */
export async function removeReviewImage(
  tx: Tx,
  args: { id: number; url: string; now: Date },
): Promise<boolean> {
  const rows = await tx
    .update(productReviews)
    .set({ images: sql`${productReviews.images} - ${args.url}::text`, updatedAt: args.now })
    .where(and(eq(productReviews.id, args.id), sql`${productReviews.images} ? ${args.url}::text`))
    .returning({ id: productReviews.id });
  return rows.length > 0;
}

/**
 * 注销: every review the user wrote stays, with no name or face on it.
 * Soft-deleted ones too — deleted is not forgotten.
 */
export async function clearReviewAuthorOf(
  tx: Tx,
  args: { userId: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productReviews, {
    where: and(
      eq(productReviews.userId, args.userId),
      or(isNotNull(productReviews.authorNickname), isNotNull(productReviews.authorAvatarUrl)),
    ),
    set: { authorNickname: null, authorAvatarUrl: null, updatedAt: args.now },
  });
}

/**
 * `published`/`pending` → `pending` with a moderation reason, for a review that
 * has none yet (CONTENT-006). A reason already recorded means a person has
 * looked or will, so that row is left alone; a hidden or deleted review too.
 */
export async function holdReview(
  tx: Tx,
  args: { id: number; reason: string; now: Date },
): Promise<boolean> {
  const rows = await tx
    .update(productReviews)
    .set({ status: 'pending', moderationReason: args.reason, updatedAt: args.now })
    .where(
      and(
        eq(productReviews.id, args.id),
        inArray(productReviews.status, ['published', 'pending']),
        isNull(productReviews.moderationReason),
        isNull(productReviews.deletedAt),
      ),
    )
    .returning({ id: productReviews.id });
  return rows.length > 0;
}

export interface ReviewListFilter {
  productId?: number | undefined;
  userId?: number | undefined;
  keyword?: string | undefined;
  status?: readonly ReviewStatusValue[] | undefined;
  rating?: 'good' | 'medium' | 'bad' | undefined;
  hasReply?: boolean | undefined;
  hasImages?: boolean | undefined;
}

function ratingCondition(rating: 'good' | 'medium' | 'bad'): SQL {
  if (rating === 'good') return gte(productReviews.productScore, 4);
  if (rating === 'medium') return eq(productReviews.productScore, 3);
  return lte(productReviews.productScore, 2);
}

function reviewWhere(filter: ReviewListFilter): SQL | undefined {
  return allOf(
    liveReview(),
    filter.productId !== undefined ? eq(productReviews.productId, filter.productId) : undefined,
    filter.userId !== undefined ? eq(productReviews.userId, filter.userId) : undefined,
    filter.keyword
      ? sql`${productReviews.content} ilike ${likePattern(filter.keyword)}`
      : undefined,
    filter.status && filter.status.length > 0
      ? inArray(productReviews.status, [...filter.status])
      : undefined,
    filter.rating ? ratingCondition(filter.rating) : undefined,
    filter.hasReply === true
      ? isNotNull(productReviews.replyContent)
      : filter.hasReply === false
        ? isNull(productReviews.replyContent)
        : undefined,
    filter.hasImages === true
      ? sql`jsonb_array_length(${productReviews.images}) > 0`
      : filter.hasImages === false
        ? sql`jsonb_array_length(${productReviews.images}) = 0`
        : undefined,
  );
}

export async function listReviews(
  db: DbOrTx,
  args: ReviewListFilter & {
    offset: number;
    limit: number;
    sortBy?: 'id' | 'productScore' | 'createdAt' | undefined;
    sortOrder?: 'asc' | 'desc' | undefined;
  },
): Promise<{ rows: ReviewRow[]; total: number }> {
  const where = reviewWhere(args);
  const column = {
    id: productReviews.id,
    productScore: productReviews.productScore,
    createdAt: productReviews.createdAt,
  }[args.sortBy ?? 'id'];
  const direction = args.sortOrder === 'asc' ? asc : desc;

  const [rows, counted] = await Promise.all([
    db
      .select()
      .from(productReviews)
      .where(where)
      .orderBy(direction(column), desc(productReviews.id))
      .offset(args.offset)
      .limit(args.limit),
    db.select({ total: count }).from(productReviews).where(where),
  ]);
  return { rows, total: counted[0]?.total ?? 0 };
}

/**
 * Reply, guarded on there *being* no reply yet.
 *
 * Two operators answering the same complaint at the same moment must not both
 * believe they did; the loser gets `CATALOG_REVIEW_ALREADY_REPLIED` and can
 * refresh to see the other answer.
 */
export async function replyToReview(
  tx: Tx,
  args: { id: number; content: string; adminId: number | null; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productReviews, {
    where: and(eq(productReviews.id, args.id), isNull(productReviews.replyContent), liveReview()),
    set: {
      replyContent: args.content,
      replyAt: args.now,
      replyByAdminId: args.adminId,
      updatedAt: args.now,
    },
  });
}

/** Editing a reply that already exists. Separate statement, separate audit line. */
export async function updateReviewReply(
  tx: Tx,
  args: { id: number; content: string; adminId: number | null; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productReviews, {
    where: and(eq(productReviews.id, args.id), liveReview()),
    set: {
      replyContent: args.content,
      replyAt: args.now,
      replyByAdminId: args.adminId,
      updatedAt: args.now,
    },
  });
}

export async function setReviewStatus(
  tx: Tx,
  args: { id: number; from: readonly ReviewStatusValue[]; to: ReviewStatusValue; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productReviews, {
    where: and(
      eq(productReviews.id, args.id),
      inArray(productReviews.status, [...args.from]),
      liveReview(),
    ),
    set: { status: args.to, updatedAt: args.now },
  });
}

/**
 * 批量审核, as one conditional update.
 *
 * `status <> to` in the WHERE is what makes `updated` mean "rows this call
 * moved" rather than "ids you sent": an operator re-submitting the same
 * selection sees 0, which is the truth.
 */
export async function setReviewStatuses(
  tx: Tx,
  args: { ids: readonly number[]; to: ReviewStatusValue; now: Date },
): Promise<number> {
  if (args.ids.length === 0) return 0;
  const { affected } = await conditionalUpdate(tx, productReviews, {
    where: and(
      inArray(productReviews.id, [...args.ids]),
      ne(productReviews.status, args.to),
      liveReview(),
    ),
    set: { status: args.to, updatedAt: args.now },
  });
  return affected;
}

export async function softDeleteReview(
  tx: Tx,
  args: { id: number; now: Date },
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(tx, productReviews, {
    where: and(eq(productReviews.id, args.id), liveReview()),
    set: { deletedAt: args.now, updatedAt: args.now },
  });
}

export interface ReviewCountsRow {
  productId: number;
  total: number;
  good: number;
  medium: number;
  bad: number;
  withImages: number;
  scoreSum: number;
}

/**
 * The review header, for many products at once.
 *
 * One grouped query whatever the page size — the storefront list renders twenty
 * cards and a per-product count would be twenty round trips.
 */
export async function reviewCountsFor(
  db: DbOrTx,
  productIds: readonly number[],
): Promise<Map<number, ReviewCountsRow>> {
  const out = new Map<number, ReviewCountsRow>();
  if (productIds.length === 0) return out;
  const rows = await db
    .select({
      productId: productReviews.productId,
      total: count,
      good: sql<number>`count(*) filter (where ${productReviews.productScore} >= 4)::int`,
      medium: sql<number>`count(*) filter (where ${productReviews.productScore} = 3)::int`,
      bad: sql<number>`count(*) filter (where ${productReviews.productScore} <= 2)::int`,
      withImages: sql<number>`count(*) filter (where jsonb_array_length(${productReviews.images}) > 0)::int`,
      scoreSum: sql<number>`coalesce(sum(${productReviews.productScore}), 0)::int`,
    })
    .from(productReviews)
    .where(
      and(
        inArray(productReviews.productId, [...productIds]),
        eq(productReviews.status, 'published'),
        liveReview(),
      ),
    )
    .groupBy(productReviews.productId);
  for (const row of rows) out.set(row.productId, row);
  return out;
}

// ---------------------------------------------------------------------------
// browse history and search logs  (schema/stats.ts)
// ---------------------------------------------------------------------------

export type ProductEventPlatform = (typeof productEvents.$inferSelect)['platform'];

/**
 * Record a product view.
 *
 * Browse history and the operator's traffic dashboard read the same rows, so a
 * view is written once. `user_visits` (page path, geo, dwell time) belongs to
 * the user domain and is a different thing.
 */
export async function recordProductView(
  tx: DbOrTx,
  args: { productId: number; userId: number | null; platform: ProductEventPlatform },
): Promise<void> {
  await tx.insert(productEvents).values({
    productId: args.productId,
    userId: args.userId,
    kind: 'view',
    quantity: 1,
    platform: args.platform,
  });
}

export async function recordFavoriteEvent(
  tx: Tx,
  args: { productId: number; userId: number; platform: ProductEventPlatform },
): Promise<void> {
  await tx.insert(productEvents).values({
    productId: args.productId,
    userId: args.userId,
    kind: 'favorite',
    quantity: 1,
    platform: args.platform,
  });
}

/**
 * Record units going into a cart.
 *
 * Unlike a view or a favourite this one carries a `skuId` and a real
 * `quantity`: the stats product page reports 加购件数 as
 * `sum(quantity) filter (where kind = 'cart')`, not a row count. The event is
 * the *delta* the shopper just added, so two taps of 加入购物车 with `1` are
 * two rows summing to 2.
 *
 * Append-only and never retracted: emptying the cart afterwards does not
 * un-add it, because the metric is interest, not inventory.
 */
export async function recordCartEvent(
  tx: Tx,
  args: {
    productId: number;
    skuId: number;
    userId: number;
    quantity: number;
    platform: ProductEventPlatform;
  },
): Promise<void> {
  await tx.insert(productEvents).values({
    productId: args.productId,
    skuId: args.skuId,
    userId: args.userId,
    kind: 'cart',
    quantity: args.quantity,
    platform: args.platform,
  });
}

/**
 * 我的足迹: the shopper's most recent view of each product.
 *
 * `max(created_at)` grouped by product, so revisiting a product moves it to the
 * top rather than filling the list with the same card twenty times.
 */
export async function listBrowseHistory(
  db: DbOrTx,
  args: { userId: number; since: Date; offset: number; limit: number },
): Promise<{ rows: { productId: number; viewedAt: Date }[]; total: number }> {
  const where = and(
    eq(productEvents.userId, args.userId),
    eq(productEvents.kind, 'view'),
    gte(productEvents.createdAt, args.since),
  );
  const [rows, counted] = await Promise.all([
    db
      .select({
        productId: productEvents.productId,
        viewedAt: sql<Date>`max(${productEvents.createdAt})`,
      })
      .from(productEvents)
      .where(where)
      .groupBy(productEvents.productId)
      .orderBy(desc(sql`max(${productEvents.createdAt})`))
      .offset(args.offset)
      .limit(args.limit),
    db
      .select({ total: sql<number>`count(distinct ${productEvents.productId})::int` })
      .from(productEvents)
      .where(where),
  ]);
  return {
    rows: rows.map((r) => ({ productId: r.productId, viewedAt: new Date(r.viewedAt) })),
    total: counted[0]?.total ?? 0,
  };
}

export async function clearBrowseHistory(
  tx: Tx,
  args: { userId: number; productIds?: readonly number[] | undefined },
): Promise<number> {
  const rows = await tx
    .delete(productEvents)
    .where(
      allOf(
        eq(productEvents.userId, args.userId),
        eq(productEvents.kind, 'view'),
        args.productIds && args.productIds.length > 0
          ? inArray(productEvents.productId, [...args.productIds])
          : undefined,
      ),
    )
    .returning({ id: productEvents.id });
  return rows.length;
}

/** The retention sweep. Batched by id so a big backlog drains over several passes. */
export async function pruneBrowseHistory(
  tx: Tx,
  args: { before: Date; limit: number },
): Promise<number> {
  const due = await tx
    .select({ id: productEvents.id })
    .from(productEvents)
    .where(and(eq(productEvents.kind, 'view'), lt(productEvents.createdAt, args.before)))
    .orderBy(asc(productEvents.id))
    .limit(args.limit);
  if (due.length === 0) return 0;
  const deleted = await tx
    .delete(productEvents)
    .where(
      inArray(
        productEvents.id,
        due.map((r) => r.id),
      ),
    )
    .returning({ id: productEvents.id });
  return deleted.length;
}

export async function recordSearch(
  tx: Tx,
  args: {
    userId: number | null;
    keyword: string;
    resultCount: number;
    platform: ProductEventPlatform;
  },
): Promise<void> {
  await tx.insert(searchLogs).values({
    userId: args.userId,
    keyword: args.keyword,
    resultCount: args.resultCount,
    platform: args.platform,
  });
}

/**
 * 热门搜索词.
 *
 * `GROUP BY keyword` over a window rather than a counter kept in step by hand,
 * so a pruned log row cannot leave a phantom hot word behind. Searches that
 * found nothing are excluded: suggesting a keyword with no results is worse
 * than suggesting nothing.
 */
export async function hotKeywords(
  db: DbOrTx,
  args: { since: Date; limit: number },
): Promise<{ keyword: string; count: number }[]> {
  if (args.limit === 0) return [];
  const rows = await db
    .select({ keyword: searchLogs.keyword, total: count })
    .from(searchLogs)
    .where(and(gte(searchLogs.createdAt, args.since), gt(searchLogs.resultCount, 0)))
    .groupBy(searchLogs.keyword)
    .orderBy(desc(count), asc(searchLogs.keyword))
    .limit(args.limit);
  return rows.map((r) => ({ keyword: r.keyword, count: r.total }));
}

export async function listSearchHistory(
  db: DbOrTx,
  args: { userId: number; limit: number },
): Promise<{ keyword: string; searchedAt: Date }[]> {
  if (args.limit === 0) return [];
  const rows = await db
    .select({
      keyword: searchLogs.keyword,
      searchedAt: sql<Date>`max(${searchLogs.createdAt})`,
    })
    .from(searchLogs)
    .where(eq(searchLogs.userId, args.userId))
    .groupBy(searchLogs.keyword)
    .orderBy(desc(sql`max(${searchLogs.createdAt})`))
    .limit(args.limit);
  return rows.map((r) => ({ keyword: r.keyword, searchedAt: new Date(r.searchedAt) }));
}

export async function clearSearchHistory(tx: Tx, userId: number): Promise<number> {
  const rows = await tx
    .delete(searchLogs)
    .where(eq(searchLogs.userId, userId))
    .returning({ id: searchLogs.id });
  return rows.length;
}

/** Only the tests need this; everything else goes through the port. */
export async function stockAndSalesOf(
  db: DbOrTx,
  skuId: number,
): Promise<{ stock: number; sales: number }> {
  const rows = await db
    .select({ stock: productSkus.stock, sales: productSkus.sales })
    .from(productSkus)
    .where(eq(productSkus.id, skuId))
    .limit(1);
  return rows[0] ?? { stock: 0, sales: 0 };
}
