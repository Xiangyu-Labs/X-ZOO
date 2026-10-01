import { useEffect, useRef, useState } from 'react';
import { useDidHide, useDidShow } from '@tarojs/taro';
import { useCartCount } from '@/data/cart';
import { assetUrl } from '@/lib/asset-url';
import {
  applyCartBadge,
  applyTabBarLook,
  takeTabParams,
  type RouteParamsOf,
  type TabKey,
  type TabBarLook,
} from '@/platform';
import { useThemeStore } from '@/theme/store';

function resolvedLook(look: TabBarLook): TabBarLook {
  return {
    ...look,
    items: look.items.map((item) => ({
      ...item,
      iconUrl: assetUrl(item.iconUrl),
      selectedIconUrl: assetUrl(item.selectedIconUrl),
    })),
  };
}

/**
 * What every tab page does (pages.md §3.2):
 *
 * - keeps the native tab bar in step: the shop's look (`app/config` appearance) and the cart
 *   badge. WeChat refuses tab-bar calls from a non-tab page, so they are re-applied on show;
 * - hands over the params a `navigate()` left for this tab (`switchTab` takes no query), once
 *   per show. Returns them; `{}` when none.
 */
export function useTabPage<K extends TabKey>(key: K): RouteParamsOf<K> {
  const cartCount = useCartCount();
  const look = useThemeStore((state) => state.tabBar);
  const revision = useThemeStore((state) => state.revision);
  const shown = useRef(false);
  const applied = useRef(-1);
  const [params, setParams] = useState<RouteParamsOf<K>>(() => takeTabParams(key));

  useDidShow(() => {
    shown.current = true;
    applied.current = revision;
    void applyTabBarLook(resolvedLook(look));
    void applyCartBadge(cartCount);
    const pending = takeTabParams(key);
    if (Object.keys(pending).length > 0) setParams(pending);
  });
  useDidHide(() => {
    shown.current = false;
  });

  useEffect(() => {
    if (shown.current) void applyCartBadge(cartCount);
  }, [cartCount]);
  useEffect(() => {
    if (shown.current && applied.current !== revision) {
      applied.current = revision;
      void applyTabBarLook(resolvedLook(look));
    }
  }, [look, revision]);

  return params;
}
