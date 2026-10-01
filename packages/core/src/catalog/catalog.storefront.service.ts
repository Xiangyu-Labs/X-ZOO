import type { PageQuery } from '@shop/contracts/conventions';
import type {
  FavoriteAddBatchBody,
  FavoriteAddBatchResult,
  FavoriteItem,
  HistoryItem,
  ProductCard,
  StorefrontProduct,
  StorefrontProductListQuery,
  StorefrontSku,
} from '@shop/contracts/catalog/schemas';

import * as coupon from '../coupon';
import { DomainError } from '../kernel/errors';
import { requireUserId, type Ctx } from '../kernel/context';
import { catalogConfig } from './catalog.config';
import * as repo from './catalog.repo';
import { normaliseKeyword, summariseReviews } from './catalog.rules';
import { pageBounds, platformOf, toProductCard } from './catalog.service';

/**
 * What a shopper sees: the category menu, the product list and page, search,
 * favourites and 我的足迹.
 *
 * Every read here goes through a repo function that has `status = 'on_shelf'`
 * and `deleted_at IS NULL` built into its WHERE clause — not passed in as an
 * option a caller could forget. That is half of 下架 hiding a product
 * everywhere at once, and the reason `listSellableProducts` and
 * `findSellableProduct` exist as separate functions from `listProducts` and
 * `findProduct` rather than as a flag on them.
 */

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

/**
 * The storefront menu.
 *
 * `version` is derived from the newest update plus the row count, so any
 * insert, edit, hide or delete moves it. A client may cache the tree and
 * refetch only when it changes. A key bumped by hand would be forgotten, and
 * shoppers would see last month's menu until the cache expired.
 */
export async function categoryTree(ctx: Ctx): Promise<{
  items: {
    id: string;
    name: string;
    iconUrl: string | null;
    bannerUrl: string | null;
    children: {
      id: string;
      name: string;
      iconUrl: string | null;
      bannerUrl: string | null;
      children: { id: string; name: string; iconUrl: string | null; bannerUrl: string | null }[];
    }[];
  }[];
  version: string;
}> {
  const [rows, version] = await Promise.all([
    repo.listAllCategories(ctx.db, { visibleOnly: true }),
    repo.categoryVersion(ctx.db),
  ]);

  const slim = (row: repo.CategoryRow) => ({
    id: String(row.id),
    name: row.name,
    iconUrl: row.iconUrl,
    bannerUrl: row.bannerUrl,
  });
  const childrenOf = (parentId: number | null) => rows.filter((row) => row.parentId === parentId);

  return {
    items: childrenOf(null).map((root) => ({
      ...slim(root),
      children: childrenOf(root.id).map((branch) => ({
        ...slim(branch),
        children: childrenOf(branch.id).map(slim),
      })),
    })),
    version,
  };
}

// ---------------------------------------------------------------------------
// products
// ---------------------------------------------------------------------------

/**
 * The list, and the search.
 *
 * Search is `ILIKE '%…%'` over `name` and `keyword`, served by the two
 * `gin_trgm_ops` indexes. That makes it case-insensitive and substring by
 * construction — including for Chinese, where trigrams ignore word boundaries,
 * so 白T恤 finds 经典白T恤. `%` and `_` in the shopper's input are escaped by
 * `likePattern`, so searching for `100%纯棉` does not match everything.
 *
 * A search with a keyword is logged, which is where 热门搜索 and the shopper's
 * own history come from. Logging is inside the same request but after the
 * count is known, so a keyword that found nothing is recorded as such and
 * never suggested to anybody else.
 */
export async function productList(
  ctx: Ctx,
  query: StorefrontProductListQuery,
): Promise<{ items: ProductCard[]; total: number; page: number; pageSize: number }> {
  const keyword = query.keyword ? normaliseKeyword(query.keyword) : undefined;

  let couponScope: repo.StorefrontProductFilter['couponScope'];
  if (query.couponId !== undefined) {
    const scope = await coupon.productScope(ctx, Number(query.couponId));
    if (scope === null) return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
    couponScope =
      scope.scope === 'products'
        ? { productIds: scope.productIds }
        : scope.scope === 'categories'
          ? { categoryIds: scope.categoryIds }
          : undefined;
  }

  const { rows, total } = await repo.listSellableProducts(ctx.db, {
    keyword: keyword || undefined,
    categoryId: query.categoryId === undefined ? undefined : Number(query.categoryId),
    labelId: query.labelId === undefined ? undefined : Number(query.labelId),
    ids: query.ids?.map(Number),
    categoryIds: query.categoryIds?.map(Number),
    labelIds: query.labelIds?.map(Number),
    priceFrom: query.priceFrom,
    priceTo: query.priceTo,
    feature: query.feature,
    couponScope,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    ...pageBounds(query),
  });

  if (keyword) {
    await ctx.withTx((tx) =>
      repo.recordSearch(tx, {
        userId: ctx.actor.kind === 'user' ? ctx.actor.id : null,
        keyword,
        resultCount: total,
        platform: platformOf(ctx),
      }),
    );
  }

  const labels = await repo.labelsFor(
    ctx.db,
    rows.map((r) => r.id),
  );
  return {
    items: rows.map((row) => toProductCard(row, labels.get(row.id) ?? [])),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * The product page.
 *
 * Refuses anything not on the shelf with `CATALOG_PRODUCT_NOT_FOUND` rather
 * than `..._NOT_ON_SALE`: a shopper following a stale link should not be told
 * that the product exists but is hidden, which is merchandising information.
 * The order path uses the other code, because there the caller is the shop
 * itself and needs to know why.
 *
 * The view is recorded here, once, into `product_events`. Browse history and
 * the operator's traffic report read the same rows, so nothing else may write a
 * second view row for the same page view.
 */
export async function productDetail(ctx: Ctx, input: { id: string }): Promise<StorefrontProduct> {
  const productId = Number(input.id);
  const row = await repo.findSellableProduct(ctx.db, productId);
  if (!row) throw new DomainError('CATALOG_PRODUCT_NOT_FOUND');

  const userId = ctx.actor.kind === 'user' ? ctx.actor.id : null;

  const [labels, specs, skus, params, protections, links, descriptionHtml, counts] =
    await Promise.all([
      repo.labelsFor(ctx.db, [productId]),
      repo.listSpecs(ctx.db, productId),
      repo.listVisibleSkus(ctx.db, productId),
      repo.listParams(ctx.db, productId),
      repo.protectionsFor(ctx.db, productId),
      repo.linkedIds(ctx.db, productId),
      repo.findDescription(ctx.db, productId),
      repo.reviewCountsFor(ctx.db, [productId]),
    ]);

  const favorited = userId === null ? null : await repo.isFavorited(ctx.db, { userId, productId });

  // One insert, no row lock. Bumping `products.views` here too, in the same
  // transaction, would make every concurrent view of one product queue on that
  // product's row lock — the page most likely to be hot would be the one that
  // slowed down — and every bump would write a new wide `products` tuple. The
  // worker folds these rows into `products.views` once a minute
  // (`foldProductViews`, `catalog.foldProductViews`).
  await repo.recordProductView(ctx.db, { productId, userId, platform: platformOf(ctx) });

  return {
    ...toProductCard(row, labels.get(productId) ?? []),
    // The folded count, up to a minute behind, and never this visit: the
    // shopper does not see his own view counted. One less thing to explain.
    views: row.views,
    sliderImages: row.sliderImages,
    videoUrl: row.videoUrl,
    specMode: row.specMode,
    minPurchaseQuantity: row.minPurchaseQuantity,
    purchaseLimitMode: row.purchaseLimitMode,
    purchaseLimitQuantity: row.purchaseLimitQuantity,
    freightMode: row.freightMode,
    fixedFreight: row.fixedFreight,
    descriptionHtml,
    specs: specs.map((entry) => ({
      name: entry.spec.name,
      values: entry.values.map((value) => ({ value: value.value, imageUrl: value.imageUrl })),
    })),
    skus: skus.map(toStorefrontSku),
    params: params.map((param) => ({ name: param.name, value: param.value })),
    protections: protections.map((protection) => ({
      id: String(protection.id),
      title: protection.title,
      content: protection.content,
      iconUrl: protection.iconUrl,
    })),
    customForm: row.customForm,
    favorited,
    reviewSummary: summariseReviews(
      counts.get(productId) ?? {
        productId,
        total: 0,
        good: 0,
        medium: 0,
        bad: 0,
        withImages: 0,
        scoreSum: 0,
      },
    ),
    giftCouponIds: links.giftCouponIds.map(String),
  };
}

/** The spec matrix on its own, for the cart popup. */
export async function productSkus(
  ctx: Ctx,
  input: { id: string },
): Promise<{
  productId: string;
  specMode: boolean;
  specs: { name: string; values: { value: string; imageUrl: string | null }[] }[];
  skus: StorefrontSku[];
}> {
  const productId = Number(input.id);
  const row = await repo.findSellableProduct(ctx.db, productId);
  if (!row) throw new DomainError('CATALOG_PRODUCT_NOT_FOUND');

  const [specs, skus] = await Promise.all([
    repo.listSpecs(ctx.db, productId),
    repo.listVisibleSkus(ctx.db, productId),
  ]);

  return {
    productId: String(productId),
    specMode: row.specMode,
    specs: specs.map((entry) => ({
      name: entry.spec.name,
      values: entry.values.map((value) => ({ value: value.value, imageUrl: value.imageUrl })),
    })),
    skus: skus.map(toStorefrontSku),
  };
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export async function hotKeywords(
  ctx: Ctx,
): Promise<{ items: { keyword: string; count: number }[] }> {
  const config = await ctx.config.get(catalogConfig);
  const since = new Date(ctx.clock.now().getTime() - config.hotKeywordDays * 24 * 60 * 60 * 1000);
  const rows = await repo.hotKeywords(ctx.db, { since, limit: config.hotKeywordLimit });
  return { items: rows };
}

export async function searchHistory(
  ctx: Ctx,
): Promise<{ items: { keyword: string; searchedAt: string }[] }> {
  const userId = requireUserId(ctx);
  const config = await ctx.config.get(catalogConfig);
  const rows = await repo.listSearchHistory(ctx.db, {
    userId,
    limit: config.searchHistoryLimit,
  });
  return {
    items: rows.map((row) => ({ keyword: row.keyword, searchedAt: row.searchedAt.toISOString() })),
  };
}

export async function clearSearchHistory(ctx: Ctx): Promise<void> {
  const userId = requireUserId(ctx);
  await ctx.withTx((tx) => repo.clearSearchHistory(tx, userId));
}

// ---------------------------------------------------------------------------
// favourites
// ---------------------------------------------------------------------------

/**
 * The cards of the products a shopper favourited or viewed, **whether or not
 * they are still for sale**. Dropping the off-shelf ones left `total` (and
 * 我的's count) counting rows nobody could see, opened a list on an empty page
 * (「还没有收藏」 over a full list) and gave the shopper no way to remove them.
 * One no longer for sale is drawn sold out — no stock, no 加入购物车 — and carries
 * `available: false`, so the list says 已下架 the way its product page does.
 */
async function listedCards(
  db: Ctx['db'],
  productIds: readonly number[],
): Promise<Map<number, { product: ProductCard; available: boolean }>> {
  const products = await repo.productsByIds(db, productIds);
  const labels = await repo.labelsFor(db, [...products.keys()]);
  const cards = new Map<number, { product: ProductCard; available: boolean }>();
  for (const product of products.values()) {
    const card = toProductCard(product, labels.get(product.id) ?? []);
    const available = product.status === 'on_shelf' && product.deletedAt === null;
    cards.set(product.id, {
      product: available ? card : { ...card, stock: 0, canAddToCart: false },
      available,
    });
  }
  return cards;
}

/** 我的收藏, newest first; every row counted in `total` is on its page (see `listedCards`). */
export async function favoriteList(
  ctx: Ctx,
  query: PageQuery,
): Promise<{ items: FavoriteItem[]; total: number; page: number; pageSize: number }> {
  const userId = requireUserId(ctx);
  const { rows, total } = await repo.listFavorites(ctx.db, { userId, ...pageBounds(query) });
  const cards = await listedCards(
    ctx.db,
    rows.map((r) => r.productId),
  );

  const items: FavoriteItem[] = [];
  for (const row of rows) {
    const listed = cards.get(row.productId);
    if (!listed) continue;
    items.push({ ...listed, createdAt: row.createdAt.toISOString() });
  }
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * Idempotent by construction: composite primary key plus
 * `ON CONFLICT DO NOTHING`. A double-tapped heart is one row and one 201, not
 * a 409 the app has to special-case.
 */
export async function favoriteAdd(
  ctx: Ctx,
  body: { productId: string },
): Promise<{ favorited: true }> {
  const userId = requireUserId(ctx);
  const productId = Number(body.productId);

  await ctx.withTx(async (tx) => {
    const product = await repo.findSellableProduct(tx, productId);
    if (!product) throw new DomainError('CATALOG_PRODUCT_NOT_FOUND');

    const added = await repo.addFavorite(tx, { userId, productId });
    if (added) {
      await repo.recordFavoriteEvent(tx, { productId, userId, platform: platformOf(ctx) });
    }
  });

  return { favorited: true };
}

/**
 * 批量收藏.
 *
 * One transaction rather than N requests from the storefront, so the answer's
 * `favorited: true` is true of every id at the same instant. Partial-tolerant
 * on purpose: an id whose product went off shelf between the list and the
 * button comes back `false` rather than taking the other 49 down with it —
 * exactly the trade 再次购买 makes.
 *
 * Duplicate ids are collapsed first, so `added` counts rows and not requests.
 */
export async function favoriteAddBatch(
  ctx: Ctx,
  body: FavoriteAddBatchBody,
): Promise<FavoriteAddBatchResult> {
  const userId = requireUserId(ctx);
  const productIds = [...new Set(body.productIds.map(Number))];

  return ctx.withTx(async (tx) => {
    const sellable = await repo.findSellableProducts(tx, productIds);
    const platform = platformOf(ctx);
    const favorited = new Map<number, boolean>();
    let added = 0;

    for (const productId of productIds) {
      if (!sellable.has(productId)) {
        favorited.set(productId, false);
        continue;
      }
      // `ON CONFLICT DO NOTHING` on the composite primary key: a product the
      // shopper already favourited is `true` with nothing written, which is
      // what makes the whole call replay-safe.
      const inserted = await repo.addFavorite(tx, { userId, productId });
      if (inserted) {
        added += 1;
        await repo.recordFavoriteEvent(tx, { productId, userId, platform });
      }
      favorited.set(productId, true);
    }

    return {
      added,
      items: body.productIds.map((productId) => ({
        productId,
        favorited: favorited.get(Number(productId)) ?? false,
      })),
    };
  });
}

export async function favoriteRemove(ctx: Ctx, input: { productId: string }): Promise<void> {
  const userId = requireUserId(ctx);
  await ctx.withTx((tx) =>
    repo.removeFavorites(tx, { userId, productIds: [Number(input.productId)] }),
  );
}

export async function favoriteRemoveBatch(
  ctx: Ctx,
  body: { productIds: string[] },
): Promise<{ removed: number }> {
  const userId = requireUserId(ctx);
  const removed = await ctx.withTx((tx) =>
    repo.removeFavorites(tx, { userId, productIds: body.productIds.map(Number) }),
  );
  return { removed };
}

// ---------------------------------------------------------------------------
// browse history
// ---------------------------------------------------------------------------

/**
 * 我的足迹, derived from `product_events` rather than a table of its own.
 *
 * Grouped by product and ordered by the most recent view, so revisiting a
 * product moves it to the top instead of filling the list with twenty copies,
 * and the database does the de-duplication rather than the application, so the
 * page does not slow down the more a shopper browses.
 *
 * The window is `browseHistoryDays`; the pruning job removes what falls out of
 * it, so the list and the retention policy cannot disagree.
 */
export async function historyList(
  ctx: Ctx,
  query: PageQuery,
): Promise<{ items: HistoryItem[]; total: number; page: number; pageSize: number }> {
  const userId = requireUserId(ctx);
  const config = await ctx.config.get(catalogConfig);
  const since = new Date(
    ctx.clock.now().getTime() - config.browseHistoryDays * 24 * 60 * 60 * 1000,
  );

  const { rows, total } = await repo.listBrowseHistory(ctx.db, {
    userId,
    since,
    ...pageBounds(query),
  });

  const cards = await listedCards(
    ctx.db,
    rows.map((r) => r.productId),
  );

  const items: HistoryItem[] = [];
  for (const row of rows) {
    const listed = cards.get(row.productId);
    if (!listed) continue;
    items.push({ ...listed, viewedAt: row.viewedAt.toISOString() });
  }
  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function historyClear(ctx: Ctx): Promise<void> {
  const userId = requireUserId(ctx);
  await ctx.withTx((tx) => repo.clearBrowseHistory(tx, { userId }));
}

export async function historyRemove(
  ctx: Ctx,
  body: { productIds: string[] },
): Promise<{ removed: number }> {
  const userId = requireUserId(ctx);
  const removed = await ctx.withTx((tx) =>
    repo.clearBrowseHistory(tx, { userId, productIds: body.productIds.map(Number) }),
  );
  return { removed };
}

/**
 * The retention sweep, called by the worker.
 *
 * Batched so a long-neglected shop drains over several runs instead of holding
 * one long transaction over a million rows.
 */
export async function pruneBrowseHistory(
  ctx: Ctx,
  options: { limit?: number } = {},
): Promise<{ deleted: number }> {
  const config = await ctx.config.get(catalogConfig);
  const before = new Date(
    ctx.clock.now().getTime() - config.browseHistoryDays * 24 * 60 * 60 * 1000,
  );
  const deleted = await ctx.withTx((tx) =>
    repo.pruneBrowseHistory(tx, { before, limit: options.limit ?? 5000 }),
  );
  return { deleted };
}

// ---------------------------------------------------------------------------
// row -> DTO
// ---------------------------------------------------------------------------

function toStorefrontSku(row: repo.SkuRow): StorefrontSku {
  return {
    id: String(row.id),
    skuCode: row.skuCode,
    specText: row.specText,
    specValues: row.specValues,
    imageUrl: row.imageUrl,
    price: row.price,
    originalPrice: row.originalPrice,
    stock: row.stock,
    weight: row.weight,
    volume: row.volume,
  };
}
