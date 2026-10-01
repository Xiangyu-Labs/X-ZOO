import type { ResponseOf } from '@shop/api-client';
import { useRouteQuery } from '@shop/api-client/react';
import { useEffect, useState } from 'react';
import { storage } from '@/platform';

export type CityTree = ResponseOf<'shipping.cityTree'>;
export type CityProvince = CityTree['items'][number];

export const CITY_TREE_KEY = 'shop.city-tree';

function cached(): CityTree | null {
  const raw = storage.get(CITY_TREE_KEY);
  if (!raw) return null;
  try {
    const tree = JSON.parse(raw) as CityTree;
    return Array.isArray(tree.items) && typeof tree.version === 'string' ? tree : null;
  } catch {
    return null;
  }
}

/**
 * 省市区 (`GET /cities`). The tree is seed data that never changes under a `version`
 * (CITY-001), so once fetched it is kept in storage and never asked for again on this phone.
 */
export function useCityTree(enabled = true) {
  const [initial] = useState(cached);
  const query = useRouteQuery('shipping.cityTree', undefined, {
    enabled: enabled && !initial,
    staleTime: Infinity,
    gcTime: Infinity,
    ...(initial ? { initialData: initial } : {}),
  });
  const fresh = !initial ? query.data : undefined;
  useEffect(() => {
    if (fresh) storage.set(CITY_TREE_KEY, JSON.stringify(fresh));
  }, [fresh]);
  return query;
}
