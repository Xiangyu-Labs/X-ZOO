import { routeKey, useRouteQuery } from '@shop/api-client/react';
import { useSignedIn } from '@/session/session';
import { useRefetchOnShow } from './use-refetch-on-show';

/**
 * The cart tab's badge: `GET /api/v1/cart/count` (`availableCount`, the rows that can still be
 * bought; a 失效 row is not something waiting to be checked out). Only a
 * signed-in shopper has a cart; signed out it is 0 and nothing is asked. Refetched when a page
 * that shows it comes back, and invalidated by every cart mutation (`cart.count` in their
 * `invalidate` lists).
 */
export function useCartCount(): number {
  const signedIn = useSignedIn();
  const count = useRouteQuery('cart.count', undefined, { enabled: signedIn });
  useRefetchOnShow(routeKey('cart.count'));
  return signedIn ? (count.data?.availableCount ?? 0) : 0;
}
