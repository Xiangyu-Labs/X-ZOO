import { catalogAdminProductList } from '@shop/contracts/catalog/catalog.product.admin.contract';
import { catalogAdminCategoryTree } from '@shop/contracts/catalog/catalog.category.admin.contract';
import { catalogAdminLabelList } from '@shop/contracts/catalog/catalog.taxonomy.admin.contract';

import { callRoute } from '../api';
import { formatMoney } from '../kit';
import type { DecorRecord, DecorRecordPage, DecorRecordQuery, DecorTreeNode } from './record-types';

/**
 * The catalog's half of the editor's record pickers: 商品, 商品标签 and the
 * 商品分类 tree, over the catalog admin contracts. `createDecorRecordSource`
 * in `records.tsx` composes these with the other kinds.
 *
 * Plain functions over `callRoute` rather than hooks: the record source is a
 * port a picker calls inside a TanStack query, not a component. The caching
 * is the picker's `useQuery`; this layer only maps contract DTOs onto the
 * picker's `{id, name, image, subtitle}`.
 *
 * There is no `brand` kind. The shop has no 品牌 table, so there is no route
 * to page and nothing to pick.
 */

function flattenTree(
  nodes: readonly { id: string; name: string; children?: readonly unknown[] }[],
): DecorTreeNode[] {
  return nodes.map((node) => {
    const children = (node.children ?? []) as {
      id: string;
      name: string;
      children?: readonly unknown[];
    }[];
    return {
      id: node.id,
      name: node.name,
      ...(children.length > 0 ? { children: flattenTree(children) } : {}),
    };
  });
}

/** 商品: on-shelf products only, with the price as the second line. */
export async function listProducts(query: DecorRecordQuery): Promise<DecorRecordPage> {
  const page = await callRoute(catalogAdminProductList, {
    query: {
      page: query.page,
      pageSize: query.pageSize,
      // 已上架 only: a DIY page must not advertise a product the shopper
      // cannot open.
      tab: 'on_shelf',
      ...(query.keyword ? { keyword: query.keyword } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    },
  });
  return { items: page.items.map(toProductItem), total: page.total };
}

/** The most ids one list call takes; the contract refuses more. */
const RESOLVE_CHUNK = 100;

/**
 * Stored product ids back into rows, through the product list's `ids` filter.
 * A block holds at most 50 products, so this is one call.
 *
 * Under the default tab a deleted product is absent, so it drops out here, as
 * does anything that is not an id at all. An off-shelf product is still a row,
 * marked in its second line: the operator should see what they picked even
 * while the storefront skips it.
 */
export async function resolveProducts(ids: readonly string[]): Promise<DecorRecord[]> {
  const found = new Map<string, DecorRecord>();
  const unique = [...new Set(ids)].filter((id) => /^[1-9]\d*$/.test(id));
  for (let start = 0; start < unique.length; start += RESOLVE_CHUNK) {
    const chunk = unique.slice(start, start + RESOLVE_CHUNK);
    const page = await callRoute(catalogAdminProductList, {
      query: { page: 1, pageSize: chunk.length, ids: chunk.join(',') },
    });
    for (const row of page.items) {
      const item = toProductItem(row);
      found.set(
        row.id,
        row.status === 'on_shelf' ? item : { ...item, subtitle: `${item.subtitle} · 未上架` },
      );
    }
  }
  return ids.flatMap((id) => found.get(id) ?? []);
}

/** 商品标签: enabled labels only. */
export async function listLabels(query: DecorRecordQuery): Promise<DecorRecordPage> {
  const page = await callRoute(catalogAdminLabelList, {
    query: {
      page: query.page,
      pageSize: query.pageSize,
      isEnabled: 'true',
      ...(query.keyword ? { keyword: query.keyword } : {}),
    },
  });
  return {
    items: page.items.map((label) => ({
      id: label.id,
      name: label.name,
      ...(label.imageUrl ? { image: label.imageUrl } : {}),
      ...(label.categoryName ? { subtitle: label.categoryName } : {}),
    })),
    total: page.total,
  };
}

export async function resolveLabels(ids: readonly string[]): Promise<DecorRecord[]> {
  // No by-id route for labels; the list is small and one page holds it.
  const page = await callRoute(catalogAdminLabelList, { query: { page: 1, pageSize: 100 } });
  const byId = new Map(page.items.map((label) => [label.id, label.name]));
  return ids.flatMap((id) => {
    const name = byId.get(id);
    return name === undefined ? [] : [{ id, name }];
  });
}

/** The 商品分类 tree, nesting kept. */
export async function productCategoryTree(): Promise<DecorTreeNode[]> {
  const tree = await callRoute(catalogAdminCategoryTree, { query: {} });
  return flattenTree(tree.items);
}

function toProductItem(row: {
  id: string;
  name: string;
  imageUrl: string;
  price: string;
}): DecorRecord {
  return { id: row.id, name: row.name, image: row.imageUrl, subtitle: formatMoney(row.price) };
}
