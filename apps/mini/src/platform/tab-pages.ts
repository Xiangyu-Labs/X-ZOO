/**
 * The four tab pages, in tab-bar order. `app.config.ts` builds `pages` and `tabBar.list` from
 * this, and the tab-bar sync uses the index to address a tab (setTabBarBadge takes an index).
 *
 * `icon` names the bundled PNGs (paths from `src/`): `assets/tab-bar/<icon>.png` and
 * `<icon>-active.png`, drawn by `scripts/tab-icons.mjs`. A shop's uploaded icons replace them
 * at runtime (`tab-bar.ts`).
 *
 * This file is read by the Taro config compiler as well as bundled, so it must stay free of
 * runtime imports.
 */
export const TAB_PAGES = [
  { key: 'home', pagePath: 'pages/index/index', text: '首页', icon: 'home' },
  { key: 'category', pagePath: 'pages/category/index', text: '分类', icon: 'category' },
  { key: 'cart', pagePath: 'pages/cart/index', text: '购物车', icon: 'cart' },
  { key: 'me', pagePath: 'pages/me/index', text: '我的', icon: 'me' },
] as const;

export type TabKey = (typeof TAB_PAGES)[number]['key'];

export function tabIndex(key: TabKey): number {
  return TAB_PAGES.findIndex((tab) => tab.key === key);
}
