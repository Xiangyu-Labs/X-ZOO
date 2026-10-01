import type { PartInputOf } from '@shop/api-client';
import { subtreeIds, type CategoryTree, type SubCategory, type TopCategory } from './category-tree';

export type AnyCategory = TopCategory | SubCategory | SubCategory['children'][number];

export type ListQuery = PartInputOf<'catalog.productList', 'query'>;

/** The sort bar: 综合, 销量, 新品, and 价格 in either direction. */
export type ListSort = 'default' | 'sales' | 'new' | 'price-asc' | 'price-desc';

export interface PriceRange {
  from: string;
  to: string;
}

export const NO_PRICE: PriceRange = { from: '', to: '' };

const SORTS: Record<Exclude<ListSort, 'default'>, Pick<ListQuery, 'sortBy' | 'sortOrder'>> = {
  sales: { sortBy: 'sales', sortOrder: 'desc' },
  new: { sortBy: 'createdAt', sortOrder: 'desc' },
  'price-asc': { sortBy: 'price', sortOrder: 'asc' },
  'price-desc': { sortBy: 'price', sortOrder: 'desc' },
};

/** 价格 flips direction on a second tap; any other sort starts at ascending price. */
export function nextPriceSort(current: ListSort): ListSort {
  return current === 'price-asc' ? 'price-desc' : 'price-asc';
}

/** `"12.5"` → `"12.50"`; anything that is not a price → `null`. */
export function moneyOf(value: string): string | null {
  const text = value.trim();
  if (!/^\d{1,8}(\.\d{0,2})?$/.test(text)) return null;
  return Number(text).toFixed(2);
}

/**
 * The price range as the shopper typed it, made valid: blanks and non-numbers dropped, the two
 * ends swapped when typed backwards.
 */
export function normalisePrice(range: PriceRange): PriceRange {
  const from = moneyOf(range.from) ?? '';
  const to = moneyOf(range.to) ?? '';
  if (from && to && Number(from) > Number(to)) return { from: to, to: from };
  return { from, to };
}

/** Find a category at any depth. */
export function findCategory(items: CategoryTree['items'], id: string): AnyCategory | null {
  for (const top of items) {
    if (top.id === id) return top;
    for (const child of top.children) {
      if (child.id === id) return child;
      const leaf = child.children.find((node) => node.id === id);
      if (leaf) return leaf;
    }
  }
  return null;
}

export interface ListInput {
  categoryId?: string | undefined;
  keyword?: string | undefined;
  labelId?: string | undefined;
  /** A coupon template id: the products it covers. */
  couponId?: string | undefined;
  sort: ListSort;
  price: PriceRange;
  /** The category tree, when loaded: a category lists its whole subtree. */
  tree?: CategoryTree | undefined;
}

/**
 * `catalog.productList`'s query for 商品列表. A category lists the products of its subtree
 * (`categoryIds`, as 分类 does); a category the tree does not know (hidden, or the tree still
 * loading) falls back to `categoryId` alone.
 */
export function listQuery(input: ListInput): ListQuery {
  const query: ListQuery = { pageSize: 20 };
  if (input.categoryId) {
    const node = input.tree ? findCategory(input.tree.items, input.categoryId) : null;
    if (node) query.categoryIds = subtreeIds(node);
    else query.categoryId = input.categoryId;
  }
  if (input.keyword) query.keyword = input.keyword;
  if (input.labelId) query.labelId = input.labelId;
  if (input.couponId) query.couponId = input.couponId;
  if (input.sort !== 'default') Object.assign(query, SORTS[input.sort]);
  const price = normalisePrice(input.price);
  if (price.from) query.priceFrom = price.from;
  if (price.to) query.priceTo = price.to;
  return query;
}
