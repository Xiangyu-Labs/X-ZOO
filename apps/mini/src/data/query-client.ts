import {
  QueryClient,
  environmentManager,
  focusManager,
  onlineManager,
} from '@tanstack/react-query';
import { isApiError } from '@shop/api-client';
import { onAppVisibility, onNetworkReachability } from '@/platform';

/**
 * One more try for a read that failed on the way (no network, a 5xx), none for an answer
 * that will not change: a 404 (商品已下架, 订单不存在) or another 4xx shows its state at once
 * instead of after a second request and the retry delay. A 401 is renewed and replayed by the
 * session's transport before it gets here.
 */
export function retryRead(failures: number, error: unknown): boolean {
  if (failures >= 1) return false;
  return !(isApiError(error) && error.status >= 400 && error.status < 500);
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // A mini-program page stays mounted under the ones pushed on top of it; a short
        // staleTime keeps "back" from refetching everything while still refreshing on return.
        staleTime: 30_000,
        retry: retryRead,
      },
    },
  });
}

/**
 * Wires TanStack Query's focus and online managers to the mini-program instead of the DOM
 * (`visibilitychange` and `online`/`offline` do not exist there):
 *
 * - focus  = the app is in the foreground (`onAppShow` / `onAppHide`);
 * - online = `onNetworkStatusChange`, seeded with `getNetworkType`;
 * - never "server": Query decides that from `typeof window`, which in a mini-program is only
 *   defined because Taro's webpack config provides a fake `window`. A server-mode client
 *   disables refetch timers, retries and garbage collection, so it is pinned here.
 *
 * Coming back to a page inside a running app is not a focus change; `useRefetchOnShow`
 * covers that per page. Returns an uninstall function (tests).
 */
export function installQueryAdapters(): () => void {
  environmentManager.setIsServer(() => false);
  let stopFocus: (() => void) | undefined;
  let stopOnline: (() => void) | undefined;
  focusManager.setEventListener((setFocused) => {
    stopFocus = onAppVisibility((visible) => setFocused(visible));
    return () => stopFocus?.();
  });
  onlineManager.setEventListener((setOnline) => {
    stopOnline = onNetworkReachability(setOnline);
    return () => stopOnline?.();
  });
  return () => {
    stopFocus?.();
    stopOnline?.();
    focusManager.setEventListener(() => undefined);
    onlineManager.setEventListener(() => undefined);
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
  };
}
