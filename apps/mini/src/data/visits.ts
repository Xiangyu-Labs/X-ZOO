import { useRef } from 'react';
import { useDidHide, useDidShow } from '@tarojs/taro';
import { storefrontRoutes, type StorefrontRouteKey } from '@shop/api-client/routes';
import { api } from './api';

/**
 * 访问统计 (`POST /visits`, pages.md: 首页 and 商品详情): one view when the page shows, and how
 * long it stayed when it hides. The path is the page's, without its query. Best effort: a failed
 * report is dropped, never shown.
 */
export function useRecordVisit(key: StorefrontRouteKey): void {
  const shownAt = useRef(0);
  const path = `/${storefrontRoutes[key].path}`;
  useDidShow(() => {
    shownAt.current = Date.now();
    void api.call('user.recordVisit', { body: { path } }).catch(() => undefined);
  });
  useDidHide(() => {
    if (shownAt.current === 0) return;
    const stayMs = Math.min(86_400_000, Math.max(0, Date.now() - shownAt.current));
    shownAt.current = 0;
    void api.call('user.recordVisit', { body: { path, stayMs } }).catch(() => undefined);
  });
}
