import {
  fixtureArticles,
  fixtureCoupons,
  fixtureGroupbuys,
  fixtureNewUserCoupons,
  fixturePresales,
  fixtureProducts,
} from '@shop/storefront-blocks/fixtures';

import type { DecorRecord, DecorRecordSource, DecorTreeNode } from '@/admin/decor';

/**
 * The sandbox's record source: the storefront-blocks fixtures (products 12–17,
 * coupons, 拼团, 预售, articles), a few labels and a small category tree, in
 * memory.
 * The editor's pickers read it unchanged; nothing reaches a route.
 */

const PRODUCTS: DecorRecord[] = fixtureProducts.map((product) => ({
  id: product.id,
  name: product.title,
  image: product.image,
  subtitle: `¥${product.price}`,
}));

const ARTICLES: DecorRecord[] = [
  ...fixtureArticles.map((article) => ({
    id: article.id,
    name: article.title,
    subtitle: article.categoryTitle ?? undefined,
  })),
  ...Array.from({ length: 8 }, (_unused, index) => ({
    id: String(index + 1),
    name: `示例资讯 ${index + 1}`,
    subtitle: '2026-09-01',
  })),
];

const COUPONS: DecorRecord[] = [...fixtureCoupons, ...fixtureNewUserCoupons].map((coupon) => ({
  id: coupon.templateId,
  name: coupon.name,
  subtitle: `减 ¥${coupon.discountAmount}`,
}));

const GROUPBUYS: DecorRecord[] = fixtureGroupbuys.map((card) => ({
  id: card.activityId,
  name: card.title,
  image: card.imageUrl ?? undefined,
  subtitle: `${card.seatsRequired}人团 ¥${card.price}`,
}));

const PRESALES: DecorRecord[] = fixturePresales.map((card) => ({
  id: card.activityId,
  name: card.title,
  image: card.imageUrl ?? undefined,
  subtitle: `预售 ¥${card.price}`,
}));

const LABELS: DecorRecord[] = [
  { id: '1', name: '新品' },
  { id: '2', name: '热卖' },
];

const CATEGORIES: DecorTreeNode[] = [
  {
    id: '1',
    name: '茶饮',
    children: [
      { id: '3', name: '普洱' },
      { id: '4', name: '白茶' },
    ],
  },
  { id: '2', name: '器具', children: [{ id: '5', name: '茶杯' }] },
];

function rowsOf(kind: string): DecorRecord[] {
  if (kind === 'product') return PRODUCTS;
  if (kind === 'article') return ARTICLES;
  if (kind === 'label') return LABELS;
  if (kind === 'coupon') return COUPONS;
  if (kind === 'groupbuy') return GROUPBUYS;
  if (kind === 'presale') return PRESALES;
  return [];
}

export function createDecorDemoRecordSource(): DecorRecordSource {
  return {
    async list(kind, query) {
      const keyword = query.keyword?.trim() ?? '';
      const all = rowsOf(kind).filter((row) => !keyword || row.name.includes(keyword));
      const start = (query.page - 1) * query.pageSize;
      return { items: all.slice(start, start + query.pageSize), total: all.length };
    },
    async resolve(kind, ids) {
      const byId = new Map(rowsOf(kind).map((row) => [row.id, row]));
      return ids.flatMap((id) => byId.get(id) ?? []);
    },
    async categories() {
      return CATEGORIES;
    },
  };
}
