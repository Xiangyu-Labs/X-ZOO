import type { ResponseOf } from '@shop/api-client';
import { displayOf, type AppConfig } from '@/app-config';

export type CategoryTree = ResponseOf<'catalog.categoryTree'>;
export type TopCategory = CategoryTree['items'][number];
export type SubCategory = TopCategory['children'][number];

interface Node {
  id: string;
  name: string;
  children?: readonly Node[] | undefined;
}

/** A category and every category under it: what 分类 lists products of (≤ 100 ids). */
export function subtreeIds(node: Node): string[] {
  const out: string[] = [];
  const walk = (current: Node) => {
    out.push(current.id);
    for (const child of current.children ?? []) walk(child);
  };
  walk(node);
  return out.slice(0, 100);
}

/** The level-1 category that is, or holds, `id`; `null` when none does. */
export function topLevelOf(
  items: readonly TopCategory[],
  id: string | undefined,
): TopCategory | null {
  if (!id) return null;
  return items.find((top) => subtreeIds(top).includes(id)) ?? null;
}

/** Any category's name, at any depth. */
export function categoryName(items: readonly Node[], id: string): string | null {
  for (const node of items) {
    if (node.id === id) return node.name;
    const inner = categoryName(node.children ?? [], id);
    if (inner) return inner;
  }
  return null;
}

/** 分类「显示二级类目」 (pages.md §2.1): `app/config.display.categorySubcategories`. */
export function showsSubcategories(config: AppConfig | null): boolean {
  return displayOf(config).categorySubcategories;
}
