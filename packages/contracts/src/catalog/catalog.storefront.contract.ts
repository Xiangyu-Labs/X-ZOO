import { z } from 'zod';
import { id } from '../_conventions/common';
import { defineRoute } from '../_conventions/route';
import {
  favoriteAddBatchBody,
  favoriteAddBatchResult,
  favoriteAddBody,
  favoriteRemoveBody,
  favoriteRemoveResult,
  hotKeywordsResult,
  pagedFavorites,
  pagedHistory,
  pagedProductCards,
  productCardExample,
  productSkuMatrix,
  searchHistoryResult,
  storefrontCategoryTree,
  storefrontProduct,
  storefrontProductExample,
  storefrontProductListQuery,
} from './schemas';

/**
 * Storefront catalog routes: `/api/v1/catalog/*`, plus the two lists that hang
 * off the shopper rather than off a product (`/api/v1/me/favorites`,
 * `/api/v1/me/history`).
 *
 * Everything that lists products answers with `productCard`, the one shape DIY,
 * marketing, search and the cart all render.
 *
 * **Off-shelf and deleted products are invisible here, and that is a promise
 * the queries keep rather than the callers.** Every read in this file filters
 * on `status = 'on_shelf' AND deleted_at IS NULL`, including `productDetail` —
 * taking a product off the shelf must hide it *and* refuse an order for it, and
 * half of that is enforced by this file being unable to return one.
 */

const productParams = z.object({ id });

export const catalogCategoryTree = defineRoute({
  id: 'catalog.categoryTree',
  method: 'GET',
  path: '/api/v1/catalog/categories',
  auth: 'public',
  summary: '商品分类',
  tags: ['catalog'],
  response: storefrontCategoryTree,
  examples: [
    {
      name: 'tree',
      response: {
        items: [
          {
            id: '7',
            name: '男装',
            iconUrl: 'https://cdn.example.com/cate/men.png',
            bannerUrl: null,
            children: [
              {
                id: '17',
                name: 'T恤',
                iconUrl: null,
                bannerUrl: null,
                children: [],
              },
            ],
          },
        ],
        version: '1742534400-17',
      },
    },
  ],
});

export const catalogProductList = defineRoute({
  id: 'catalog.productList',
  method: 'GET',
  path: '/api/v1/catalog/products',
  auth: 'public',
  summary: '商品列表 / 搜索',
  tags: ['catalog'],
  query: storefrontProductListQuery,
  response: pagedProductCards,
  examples: [
    {
      name: 'by-category',
      query: { page: 1, pageSize: 20, categoryId: '17' },
      response: { items: [productCardExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      // Substring, case-insensitive, Chinese-safe: `pg_trgm` over `name` and
      // `keyword`. A shopper typing 白t gets 经典白T恤.
      name: 'search',
      query: { page: 1, pageSize: 20, keyword: '白t' },
      response: { items: [productCardExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      name: 'hot',
      query: { page: 1, pageSize: 20, feature: 'hot', sortBy: 'sales', sortOrder: 'desc' },
      response: { items: [productCardExample], total: 1, page: 1, pageSize: 20 },
    },
    {
      // A DIY component's 指定商品: 9 went off the shelf after the page was
      // saved, so it is skipped; the rest come back in the order asked for.
      name: 'picked',
      query: { page: 1, pageSize: 3, ids: '1,9,4' },
      response: {
        items: [productCardExample, { ...productCardExample, id: '4', name: '纯棉圆领卫衣' }],
        total: 2,
        page: 1,
        pageSize: 3,
      },
    },
    {
      name: 'by-categories',
      query: { page: 1, pageSize: 6, categoryIds: '17,18', sortBy: 'sales', sortOrder: 'desc' },
      response: { items: [productCardExample], total: 1, page: 1, pageSize: 6 },
    },
    {
      // 我的优惠券「去使用」: the products coupon template 3 covers.
      name: 'for-a-coupon',
      query: { page: 1, pageSize: 20, couponId: '3' },
      response: { items: [productCardExample], total: 1, page: 1, pageSize: 20 },
    },
  ],
});

/**
 * `user-optional`: an anonymous visitor still gets the page, with `favorited`
 * as `null` rather than `false`. Viewing also records a `product_events` row,
 * which is what the browse-history list and the operator dashboard both read.
 */
export const catalogProductDetail = defineRoute({
  id: 'catalog.productDetail',
  method: 'GET',
  path: '/api/v1/catalog/products/:id',
  auth: 'user-optional',
  summary: '商品详情',
  tags: ['catalog'],
  params: productParams,
  response: storefrontProduct,
  errors: ['CATALOG_PRODUCT_NOT_FOUND'],
  examples: [
    { name: 'signed-in', params: { id: '1' }, response: storefrontProductExample },
    {
      name: 'anonymous',
      params: { id: '1' },
      response: { ...storefrontProductExample, favorited: null },
    },
  ],
});

/** The SKU matrix on its own, for the cart popup. */
export const catalogProductSkus = defineRoute({
  id: 'catalog.productSkus',
  method: 'GET',
  path: '/api/v1/catalog/products/:id/skus',
  auth: 'public',
  summary: '商品规格',
  tags: ['catalog'],
  params: productParams,
  response: productSkuMatrix,
  errors: ['CATALOG_PRODUCT_NOT_FOUND'],
  examples: [
    {
      name: 'two-sku',
      params: { id: '1' },
      response: {
        productId: '1',
        specMode: true,
        specs: storefrontProductExample.specs,
        skus: storefrontProductExample.skus,
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export const catalogHotKeywords = defineRoute({
  id: 'catalog.hotKeywords',
  method: 'GET',
  path: '/api/v1/catalog/search/hot-keywords',
  auth: 'public',
  summary: '热门搜索词',
  tags: ['catalog'],
  response: hotKeywordsResult,
  examples: [
    {
      // A `GROUP BY keyword` over the last N days rather than a counter kept in
      // step by hand, so a deleted log row cannot leave a phantom hot word.
      name: 'top',
      response: {
        items: [
          { keyword: '白T恤', count: 128 },
          { keyword: '卫衣', count: 74 },
        ],
      },
    },
  ],
});

export const catalogSearchHistory = defineRoute({
  id: 'catalog.searchHistory',
  method: 'GET',
  path: '/api/v1/me/search-history',
  auth: 'user',
  summary: '我的搜索历史',
  tags: ['catalog'],
  response: searchHistoryResult,
  examples: [
    {
      name: 'recent',
      response: {
        items: [
          { keyword: '白T恤', searchedAt: '2026-09-20T19:02:00+08:00' },
          { keyword: '卫衣', searchedAt: '2026-09-19T08:41:00+08:00' },
        ],
      },
    },
  ],
});

export const catalogClearSearchHistory = defineRoute({
  id: 'catalog.clearSearchHistory',
  method: 'DELETE',
  path: '/api/v1/me/search-history',
  auth: 'user',
  summary: '清空搜索历史',
  tags: ['catalog'],
  response: z.void(),
  status: 204,
  examples: [{ name: 'ok', response: undefined }],
});

// ---------------------------------------------------------------------------
// favourites
// ---------------------------------------------------------------------------

export const catalogFavoriteList = defineRoute({
  id: 'catalog.favoriteList',
  method: 'GET',
  path: '/api/v1/me/favorites',
  auth: 'user',
  summary: '我的收藏',
  tags: ['catalog'],
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }),
  response: pagedFavorites,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: {
        items: [
          { product: productCardExample, available: true, createdAt: '2026-09-01T12:00:00+08:00' },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    },
  ],
});

/**
 * Idempotent: favouriting twice is a 201 with the same row, not a 409. The
 * heart icon is a toggle a shopper double-taps, and `ON CONFLICT DO NOTHING`
 * on the composite primary key is the whole implementation.
 */
export const catalogFavoriteAdd = defineRoute({
  id: 'catalog.favoriteAdd',
  method: 'POST',
  path: '/api/v1/me/favorites',
  auth: 'user',
  summary: '收藏商品',
  tags: ['catalog'],
  body: favoriteAddBody,
  response: z.object({ favorited: z.literal(true) }),
  status: 201,
  errors: ['CATALOG_PRODUCT_NOT_FOUND'],
  examples: [{ name: 'ok', body: { productId: '1' }, response: { favorited: true } }],
});

/**
 * 批量收藏.
 *
 * Idempotent like its singular sibling, and partial-tolerant: an id whose
 * product is gone or off shelf comes back `favorited: false` instead of taking
 * the other 49 down with it. One transaction, so the storefront's "收藏成功"
 * is true of every id the answer says `true` for.
 */
export const catalogFavoriteAddBatch = defineRoute({
  id: 'catalog.favoriteAddBatch',
  method: 'POST',
  path: '/api/v1/me/favorites/batch',
  auth: 'user',
  summary: '批量收藏商品',
  tags: ['catalog'],
  body: favoriteAddBatchBody,
  response: favoriteAddBatchResult,
  status: 201,
  examples: [
    {
      name: 'ok',
      body: { productIds: ['1', '2'] },
      response: {
        added: 2,
        items: [
          { productId: '1', favorited: true },
          { productId: '2', favorited: true },
        ],
      },
    },
    {
      name: 'one-went-off-shelf',
      body: { productIds: ['1', '2'] },
      response: {
        added: 1,
        items: [
          { productId: '1', favorited: true },
          { productId: '2', favorited: false },
        ],
      },
    },
    {
      name: 'replay',
      body: { productIds: ['1'] },
      response: { added: 0, items: [{ productId: '1', favorited: true }] },
    },
  ],
});

export const catalogFavoriteRemove = defineRoute({
  id: 'catalog.favoriteRemove',
  method: 'DELETE',
  path: '/api/v1/me/favorites/:productId',
  auth: 'user',
  summary: '取消收藏',
  tags: ['catalog'],
  params: z.object({ productId: id }),
  response: z.void(),
  status: 204,
  examples: [{ name: 'ok', params: { productId: '1' }, response: undefined }],
});

/** 批量取消收藏 from the 我的收藏 screen. A POSTed sub-resource because DELETE takes no body. */
export const catalogFavoriteRemoveBatch = defineRoute({
  id: 'catalog.favoriteRemoveBatch',
  method: 'POST',
  path: '/api/v1/me/favorites/deletions',
  auth: 'user',
  summary: '批量取消收藏',
  tags: ['catalog'],
  body: favoriteRemoveBody,
  response: favoriteRemoveResult,
  examples: [
    { name: 'two', body: { productIds: ['1', '2'] }, response: { removed: 2 } },
    { name: 'already-gone', body: { productIds: ['1'] }, response: { removed: 0 } },
  ],
});

// ---------------------------------------------------------------------------
// browse history
// ---------------------------------------------------------------------------

export const catalogHistoryList = defineRoute({
  id: 'catalog.historyList',
  method: 'GET',
  path: '/api/v1/me/history',
  auth: 'user',
  summary: '我的足迹',
  tags: ['catalog'],
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }),
  response: pagedHistory,
  examples: [
    {
      name: 'first-page',
      query: { page: 1, pageSize: 20 },
      response: {
        items: [
          { product: productCardExample, available: true, viewedAt: '2026-09-21T10:15:00+08:00' },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    },
  ],
});

export const catalogHistoryClear = defineRoute({
  id: 'catalog.historyClear',
  method: 'DELETE',
  path: '/api/v1/me/history',
  auth: 'user',
  summary: '清空足迹',
  tags: ['catalog'],
  response: z.void(),
  status: 204,
  examples: [{ name: 'ok', response: undefined }],
});

/**
 * Remove single products from the footprint list. A POSTed sub-resource for the
 * same reason as the favourites one: the ids travel in a body.
 */
export const catalogHistoryRemove = defineRoute({
  id: 'catalog.historyRemove',
  method: 'POST',
  path: '/api/v1/me/history/deletions',
  auth: 'user',
  summary: '删除足迹',
  tags: ['catalog'],
  body: z.object({ productIds: z.array(id).min(1).max(100) }),
  response: z.object({ removed: z.number().int().min(0) }),
  examples: [{ name: 'one', body: { productIds: ['1'] }, response: { removed: 3 } }],
});
