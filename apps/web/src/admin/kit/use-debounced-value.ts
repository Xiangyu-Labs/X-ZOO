'use client';

import { useEffect, useState } from 'react';

/**
 * Debounces rapid value changes (e.g. remote `<Select showSearch>` typing)
 * while resetting immediately when cleared to an empty string.
 */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), value === '' ? 0 : delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return value === '' ? value : debounced;
}
