'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

/**
 * 返回列表 lands on the list the operator left — tab, filters and page — not on
 * a fresh one. A list links to its detail with its own query string as
 * `?list=`; the detail rebuilds the list URL from a path written in code and
 * that query string only, so `?list=` can never send anyone off the console.
 */

/** `href` carrying the list's query string as `?list=`; unchanged without one. */
export function withListReturn(href: string, listSearch: string | null | undefined): string {
  if (!listSearch) return href;
  return `${href}${href.includes('?') ? '&' : '?'}list=${encodeURIComponent(listSearch)}`;
}

/** The list at `base` as the operator left it, from a `?list=` value. */
export function listReturnHref(base: string, list: string | null | undefined): string {
  const query = list ? new URLSearchParams(list).toString() : '';
  return query ? `${base}?${query}` : base;
}

/** On a list: turns a detail path into one whose 返回 comes back to this view. */
export function useDetailHref(): (href: string) => string {
  const search = useSearchParams().toString();
  return useCallback((href: string) => withListReturn(href, search), [search]);
}

/**
 * On a detail: the list to go back to, and a way to hand the same `?list=` on
 * to another page of the same record (编辑 → 卡密库存 → 返回).
 */
export function useListReturn(base: string): {
  listHref: string;
  keepList: (href: string) => string;
} {
  const list = useSearchParams().get('list');
  const keepList = useCallback((href: string) => withListReturn(href, list), [list]);
  return { listHref: listReturnHref(base, list), keepList };
}
