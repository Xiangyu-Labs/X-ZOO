import Taro, { usePullDownRefresh, useReachBottom } from '@tarojs/taro';
import { useEffect, useRef } from 'react';

/**
 * The page's native pull-to-refresh (the page config sets `enablePullDownRefresh: true`):
 * runs `refresh`, then puts WeChat's spinner away however it went.
 */
export function usePullToRefresh(refresh: () => Promise<unknown>): void {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });
  usePullDownRefresh(() => {
    void latest
      .current()
      .catch(() => undefined)
      .finally(() => void Promise.resolve(Taro.stopPullDownRefresh()).catch(() => undefined));
  });
}

/** The page scrolled to its bottom (`onReachBottom`, threshold in the page config). */
export function useScrolledToBottom(callback: () => void): void {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  });
  useReachBottom(() => latest.current());
}

/** Scroll the page to the top (回到顶部). */
export function scrollPageToTop(): void {
  void Promise.resolve(Taro.pageScrollTo({ scrollTop: 0, duration: 200 })).catch(() => undefined);
}
