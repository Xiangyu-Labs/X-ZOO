'use client';

import { catalogAdminProductList } from '@shop/contracts/catalog/catalog.product.admin.contract';
import type { AdminProductListItem } from '@shop/contracts/catalog/schemas';
import { articleListPublic } from '@shop/contracts/cms/cms.storefront.contract';
import type { ArticleListItem } from '@shop/contracts/cms/schemas';
import {
  couponClaimableList,
  couponNewUserList,
} from '@shop/contracts/coupon/coupon.storefront.contract';
import type { ClaimableCoupon } from '@shop/contracts/coupon/schemas';
import type {
  ArticleSource,
  ArticleSummary,
  CouponSource,
  CouponSummary,
  DataNeed,
  GroupbuySource,
  GroupbuySummary,
  PresaleSource,
  PresaleSummary,
  ProductSource,
  ProductSummary,
} from '@shop/contracts/decor/sources';
import { groupbuyList } from '@shop/contracts/groupbuy/groupbuy.storefront.contract';
import { presaleList } from '@shop/contracts/presale/presale.storefront.contract';
import { useQueries } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';

import { callRoute } from '../api';

/**
 * The data a block does not carry, for the editor canvas.
 *
 * A block stores *where* its records come from (`DataNeed`s, declared by the
 * block's `defineBlock({ data })`); on the storefront the page resolver answers
 * them. The canvas answers them through this port, one need at a time, so a
 * product grid shows real products while it is being edited.
 *
 * `resolve` returns what the storefront resolver would put in the slot, or
 * `null` for a need the canvas does not preview (the block then draws its
 * empty state). The admin implementation (`createAdminCanvasData`) previews
 * products through the admin catalogue, and coupons, 新人券, 拼团, 预售 and
 * 资讯 through the storefront's own public lists — the same filters the page
 * resolver applies (DECOR-013), as a signed-out shopper sees them. Per-shopper
 * state (领取状态, held 新人券) is never previewed.
 */
export interface DecorCanvasData {
  resolve(need: DataNeed): Promise<unknown>;
}

const NO_DATA: DecorCanvasData = { resolve: () => Promise.resolve(null) };

const DecorCanvasDataContext = createContext<DecorCanvasData>(NO_DATA);

export function DecorCanvasDataProvider({
  value,
  children,
}: {
  value: DecorCanvasData;
  children: ReactNode;
}) {
  return <DecorCanvasDataContext value={value}>{children}</DecorCanvasDataContext>;
}

/**
 * A block's slots, resolved: `{ products: [...] }` for a product grid. A slot
 * still loading, failed or not previewed is absent. Each need is cached by its
 * value, so an unrelated edit does not refetch.
 */
export function useCanvasSlots(needs: Readonly<Record<string, DataNeed>>): Record<string, unknown> {
  const source = useContext(DecorCanvasDataContext);
  const entries = Object.entries(needs);
  const results = useQueries({
    queries: entries.map(([, need]) => ({
      queryKey: ['decor.canvas', source === NO_DATA ? 'none' : 'live', need],
      queryFn: async () => (await source.resolve(need)) ?? null,
      staleTime: 60_000,
      retry: false,
      // A canvas that cannot preview a slot draws the block's empty state;
      // a toast per block on every edit would only be noise.
      meta: { presentError: false },
    })),
  });
  const slots: Record<string, unknown> = {};
  entries.forEach(([slot], index) => {
    const data = results[index]?.data;
    if (data !== undefined && data !== null) slots[slot] = data;
  });
  return slots;
}

// ---------------------------------------------------------------------------
// the admin's implementation
// ---------------------------------------------------------------------------

/** As `toProductSummary` in the core resolver, from the admin product row. */
export function adminProductSummary(row: AdminProductListItem): ProductSummary {
  const summary: ProductSummary = {
    id: row.id,
    title: row.name,
    image: row.imageUrl,
    price: row.price,
  };
  if (row.originalPrice !== null && Number(row.originalPrice) > Number(row.price)) {
    summary.marketPrice = row.originalPrice;
  }
  const tag = row.labels[0]?.name;
  if (tag) summary.tag = [...tag].slice(0, 8).join('');
  if (row.stock <= 0) summary.soldOut = true;
  return summary;
}

const SORTS = {
  default: {},
  sales: { sortBy: 'sales', sortOrder: 'desc' },
  newest: { sortBy: 'createdAt', sortOrder: 'desc' },
  priceAsc: { sortBy: 'price', sortOrder: 'asc' },
  priceDesc: { sortBy: 'price', sortOrder: 'desc' },
} as const;

/**
 * Products for a source, the way the storefront resolver picks them
 * (DECOR-013): a manual list in its order, on-shelf only, sold-out kept; a
 * category or label rule on-shelf *with stock*, sorted, at most `limit`.
 */
export async function previewProducts(source: ProductSource): Promise<ProductSummary[]> {
  if (source.mode === 'manual') {
    const ids = source.ids.filter((id) => /^[1-9]\d*$/.test(id));
    if (ids.length === 0) return [];
    const page = await callRoute(catalogAdminProductList, {
      query: { page: 1, pageSize: ids.length, tab: 'on_shelf', ids: ids.join(',') },
    });
    const byId = new Map(page.items.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [adminProductSummary(row)] : [];
    });
  }
  const page = await callRoute(catalogAdminProductList, {
    query: {
      page: 1,
      pageSize: Math.min(100, source.limit * 2 + 10),
      tab: 'on_shelf',
      ...(source.mode === 'category'
        ? { categoryId: source.categoryId }
        : { labelId: source.labelId }),
      ...SORTS[source.sort],
    },
  });
  return page.items
    .filter((row) => row.stock > 0)
    .slice(0, source.limit)
    .map(adminProductSummary);
}

/** As `toCouponSummary` in the core resolver: the template, without caller state. */
function couponSummaryOf(item: ClaimableCoupon): CouponSummary {
  const { claimedCount: _claimed, canClaim: _canClaim, ...rest } = item;
  return rest;
}

/** As `toArticleSummary` in the core resolver. */
function articleSummaryOf(item: ArticleListItem): ArticleSummary {
  return {
    id: item.id,
    title: item.title,
    coverImageUrl: item.coverImageUrl,
    summary: item.summary,
    author: item.author,
    categoryTitle: item.categoryTitle,
    views: item.views,
    publishedAt: item.publishedAt,
  };
}

const validIds = (ids: readonly string[]) => ids.filter((id) => /^[1-9]\d*$/.test(id));

/** Coupons claimable now: the picked ones in their order, or the first `limit`. */
export async function previewCoupons(source: CouponSource): Promise<CouponSummary[]> {
  if (source.mode === 'manual') {
    const ids = validIds(source.ids);
    if (ids.length === 0) return [];
    const page = await callRoute(couponClaimableList, {
      query: { page: 1, pageSize: ids.length, ids: ids.join(',') },
    });
    return page.items.map(couponSummaryOf);
  }
  const page = await callRoute(couponClaimableList, {
    query: { page: 1, pageSize: source.limit },
  });
  return page.items.map(couponSummaryOf);
}

/** Campaigns inside their window: the picked ones in their order, or the list's first `limit`. */
async function previewCampaigns<Card>(
  route: typeof groupbuyList | typeof presaleList,
  source: GroupbuySource | PresaleSource,
): Promise<Card[]> {
  if (source.mode === 'manual') {
    const ids = validIds(source.ids);
    if (ids.length === 0) return [];
    const page = await callRoute(route, {
      query: { page: 1, pageSize: ids.length, ids: ids.join(',') },
    });
    return page.items as Card[];
  }
  const page = await callRoute(route, { query: { page: 1, pageSize: source.limit } });
  return page.items as Card[];
}

/** Published articles: the picked ones in their order, or a category's first `limit`. */
export async function previewArticles(source: ArticleSource): Promise<ArticleSummary[]> {
  if (source.mode === 'manual') {
    const ids = validIds(source.ids);
    if (ids.length === 0) return [];
    const page = await callRoute(articleListPublic, {
      query: { page: 1, pageSize: ids.length, ids: ids.join(',') },
    });
    return page.items.map(articleSummaryOf);
  }
  const page = await callRoute(articleListPublic, {
    query: {
      page: 1,
      pageSize: source.limit,
      ...(source.categoryId ? { categoryId: source.categoryId } : {}),
    },
  });
  return page.items.map(articleSummaryOf);
}

export function createAdminCanvasData(): DecorCanvasData {
  return {
    async resolve(need) {
      switch (need.kind) {
        case 'products':
          // A rule still being set up (no category picked yet) previews nothing.
          if (need.source.mode === 'category' && !need.source.categoryId) return [];
          if (need.source.mode === 'label' && !need.source.labelId) return [];
          return previewProducts(need.source);
        case 'coupons':
          return previewCoupons(need.source);
        case 'newUserCoupons': {
          const { items } = await callRoute(couponNewUserList, {});
          return items.slice(0, need.limit).map(couponSummaryOf);
        }
        case 'groupbuys':
          return previewCampaigns<GroupbuySummary>(groupbuyList, need.source);
        case 'presales':
          return previewCampaigns<PresaleSummary>(presaleList, need.source);
        case 'articles':
          return previewArticles(need.source);
        default:
          return null;
      }
    },
  };
}
