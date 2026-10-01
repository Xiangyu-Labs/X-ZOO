import Taro from '@tarojs/taro';

/**
 * The window chrome a custom navigation bar has to clear (首页 and 我的, design.md §4.5): the
 * status bar, and the capsule (「···」 and close) WeChat draws at the top right of every page.
 *
 * The bar is as tall as the capsule plus the gap above it, twice; the capsule's left edge is
 * where the page's own content must stop. H5 has no capsule: the numbers fall back to an
 * iPhone's, which is what the H5 preview imitates.
 */
export interface NavBarMetrics {
  /** Status bar height, px. */
  statusBarHeight: number;
  /** The bar below the status bar, px. */
  navBarHeight: number;
  /** Room to leave on the right for the capsule, px (0 on H5). */
  capsuleWidth: number;
  /** The window's width, px: a design size is `px * 750 / windowWidth`. */
  windowWidth: number;
}

const FALLBACK: NavBarMetrics = {
  statusBarHeight: 20,
  navBarHeight: 44,
  capsuleWidth: 0,
  windowWidth: 375,
};

let cached: NavBarMetrics | null = null;

export function navBarMetrics(): NavBarMetrics {
  if (cached) return cached;
  try {
    const windowInfo =
      typeof Taro.getWindowInfo === 'function' ? Taro.getWindowInfo() : Taro.getSystemInfoSync();
    const statusBarHeight = windowInfo.statusBarHeight || FALLBACK.statusBarHeight;
    const windowWidth = windowInfo.windowWidth || FALLBACK.windowWidth;
    const capsule =
      typeof Taro.getMenuButtonBoundingClientRect === 'function'
        ? Taro.getMenuButtonBoundingClientRect()
        : null;
    if (!capsule || !capsule.height) {
      cached = { ...FALLBACK, statusBarHeight, windowWidth };
      return cached;
    }
    const gap = Math.max(0, capsule.top - statusBarHeight);
    cached = {
      statusBarHeight,
      navBarHeight: capsule.height + gap * 2,
      capsuleWidth: Math.max(0, windowWidth - capsule.left),
      windowWidth,
    };
    return cached;
  } catch {
    return FALLBACK;
  }
}
