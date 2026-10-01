'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

/**
 * The slice of URL state a table needs. Abstracted so `CrudTable` can be
 * driven by the real router in the app and by an in-memory store in tests
 * without pulling `next/navigation` into jsdom.
 */
export interface TableUrlState {
  read: (key: string) => string | undefined;
  /** Merge patch. `undefined` removes a key. */
  write: (patch: Record<string, string | undefined>) => void;
}

/** Namespaces keys so two tables can live on one page: `orders.page`. */
export function prefixKey(prefix: string | undefined, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

/** URL-backed state. Uses `router.replace`, so filtering doesn't spam history. */
export function useNextUrlState(): TableUrlState {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const read = useCallback((key: string) => searchParams.get(key) ?? undefined, [searchParams]);

  const write = useCallback(
    (patch: Record<string, string | undefined>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === '') next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  return useMemo(() => ({ read, write }), [read, write]);
}

/**
 * The record a list page's detail drawer shows, seeded from `?detail=<id>` so
 * a link — a notification, a dashboard tile — opens that one record rather
 * than a page that does not exist. Closing the drawer drops the parameter, so
 * a refresh does not open it again.
 */
export function useUrlDetailId(key = 'detail'): [string | null, (id: string | null) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const fromUrl = searchParams.get(key);
  const [id, setId] = useState<string | null>(fromUrl);

  // A second link followed while the page is open changes only the URL, so
  // follow it (adjusted during render, not in an effect).
  const [seenUrl, setSeenUrl] = useState(fromUrl);
  if (fromUrl !== seenUrl) {
    setSeenUrl(fromUrl);
    if (fromUrl) setId(fromUrl);
  }

  const set = useCallback(
    (next: string | null) => {
      setId(next);
      if (next !== null || !searchParams.has(key)) return;
      const params = new URLSearchParams(searchParams.toString());
      params.delete(key);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [key, router, pathname, searchParams],
  );

  return [id, set];
}

export interface MemoryUrlState extends TableUrlState {
  /** Current key/value pairs. Assert on this in tests. */
  snapshot: Record<string, string>;
}

/** In-memory `TableUrlState` for tests and for embedded tables that shouldn't touch the URL. */
export function useMemoryUrlState(initial: Record<string, string> = {}): MemoryUrlState {
  const [snapshot, setSnapshot] = useState<Record<string, string>>(initial);

  const read = useCallback((key: string) => snapshot[key], [snapshot]);

  const write = useCallback((patch: Record<string, string | undefined>) => {
    setSnapshot((prev) => {
      const next = { ...prev };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === '') delete next[key];
        else next[key] = value;
      }
      return next;
    });
  }, []);

  return useMemo(() => ({ read, write, snapshot }), [read, write, snapshot]);
}
