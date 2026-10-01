import { storage } from '@/platform';

export const FIRST_CATEGORY_KEY = 'shop.category.first';

/**
 * The level-1 category 分类 opens on (the tree's first), as the ids its product list asks for
 * (`subtreeIds`), from the last tree this phone saw. On the next cold open 分类 starts that
 * list while the tree is still on its way, so the two requests run side by side instead of
 * one after the other. It is only a guess: the list shown is always keyed by the fresh tree,
 * and a guess the tree proves wrong costs one unused request.
 */
export function recallFirstCategory(): string[] | null {
  const raw = storage.get(FIRST_CATEGORY_KEY);
  if (!raw) return null;
  try {
    const ids: unknown = JSON.parse(raw);
    return Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === 'string')
      ? (ids as string[])
      : null;
  } catch {
    return null;
  }
}

/** Keeps `ids` for the next cold open; writes only when they changed. */
export function rememberFirstCategory(ids: readonly string[]): void {
  const raw = JSON.stringify(ids);
  if (storage.get(FIRST_CATEGORY_KEY) !== raw) storage.set(FIRST_CATEGORY_KEY, raw);
}
