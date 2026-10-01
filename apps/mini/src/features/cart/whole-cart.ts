import type { ApiClient, CallOptions } from '@shop/api-client';
import { routeQueryKey, routeQueryOptions, useApiClient } from '@shop/api-client/react';
import { useQuery } from '@tanstack/react-query';
import { CART_QUERY, type CartList } from './cart-view';

/** The cart page's cache entry: the whole cart, however many pages it took. */
export const CART_KEY = routeQueryKey('cart.list', CART_QUERY);

/** A cart holds at most 300 rows (`MAX_CART_ROWS`): three pages of 100. */
const MAX_PAGES = 3;

/**
 * Every row of the cart, page after page (100 a page, the contract's ceiling), as one list.
 * The cart-wide counts and totals are the same on every page; the rows are joined, a row that
 * moved between two reads counted once.
 */
export async function readWholeCart(
  client: ApiClient,
  options: CallOptions = {},
): Promise<CartList> {
  const read = (page: number) =>
    client.call('cart.list', { query: { ...CART_QUERY.query, page } }, options);
  const first = await read(1);
  const items = [...first.items];
  const seen = new Set(items.map((item) => item.id));
  let last = first;
  for (let page = 2; items.length < first.total && page <= MAX_PAGES; page += 1) {
    last = await read(page);
    if (last.items.length === 0) break;
    for (const item of last.items) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        items.push(item);
      }
    }
  }
  return { ...last, items, total: Math.max(last.total, items.length), page: 1 };
}

/** The cart page's read: the whole cart under {@link CART_KEY}. */
export function useWholeCart(enabled: boolean) {
  const client = useApiClient();
  return useQuery({
    ...routeQueryOptions(client, 'cart.list', CART_QUERY, { enabled }),
    queryFn: ({ signal }) => readWholeCart(client, { signal }),
  });
}
