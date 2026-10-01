import type { QueryClient } from '@tanstack/react-query';
import type { RouteId } from '@shop/api-client';
import { routeKey } from '@shop/api-client/react';

/**
 * The reads a change makes stale, one list per kind of change, so every page that makes the
 * change drops the same caches. Pages in sub-packages keep their own lists for their own
 * domain (`packages/order/shared/actions.ts` `ORDER_READS`, `packages/aftersale/shared/actions.ts`
 * `REFUND_READS`); these are the ones shared across packages.
 */

/**
 * An address added, edited, removed or made the default. 确认订单 prices against the default
 * address when none is picked, and sits under the address form while a first address is added.
 */
export const ADDRESS_READS: readonly RouteId[] = [
  'user.addressList',
  'user.defaultAddress',
  'user.addressDetail',
  'order.checkoutPreview',
];

/** A coupon claimed: the lists, the wallet, and what the cart and 确认订单 say is usable. */
export const COUPON_READS: readonly RouteId[] = [
  'coupon.claimableList',
  'coupon.myList',
  'coupon.applicableList',
];

/**
 * Decorated pages carry the shopper's coupon states and counts in their personal layer
 * (DECOR-015). They are heavy to fetch again while hidden, so a change only marks them stale;
 * each page refetches a stale copy when it is shown (`useRefetchOnShow`).
 */
export const DECOR_PAGE_READS: readonly RouteId[] = [
  'decor.pageHome',
  'decor.pageResolve',
  'decor.pageUserCenter',
];

/** Marks every cached read of `ids` stale without fetching anything now. */
export function markStale(queryClient: QueryClient, ...ids: readonly RouteId[]): void {
  for (const id of ids) {
    void queryClient.invalidateQueries({ queryKey: routeKey(id), refetchType: 'none' });
  }
}
