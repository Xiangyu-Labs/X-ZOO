'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';

const listeners = new Map<string, Set<() => void>>();

function read(key: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === '1' ? true : raw === '0' ? false : null;
  } catch {
    return null;
  }
}

/**
 * A per-browser on/off preference (sider collapsed, filters expanded): `null`
 * until the operator first chooses, so the caller keeps its own default.
 *
 * The server and the first client render see `null`, so hydration matches;
 * the stored choice arrives right after. Blocked storage (a private window)
 * only means the choice lasts until reload.
 */
export function useStoredFlag(key: string): [boolean | null, (next: boolean) => void] {
  const [session, setSession] = useState<boolean | null>(null);
  const stored = useSyncExternalStore(
    (onChange) => {
      const set = listeners.get(key) ?? new Set();
      set.add(onChange);
      listeners.set(key, set);
      return () => set.delete(onChange);
    },
    () => read(key),
    () => null,
  );
  const set = useCallback(
    (next: boolean) => {
      setSession(next);
      try {
        window.localStorage.setItem(key, next ? '1' : '0');
      } catch {
        // The in-memory choice still holds.
      }
      for (const listener of listeners.get(key) ?? []) listener();
    },
    [key],
  );
  return [session ?? stored, set];
}
