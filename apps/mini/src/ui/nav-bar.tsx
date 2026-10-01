import type { ReactNode } from 'react';
import { Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { navBarMetrics, px } from '@/platform';
import './nav-bar.scss';

export interface NavBarProps {
  /** The title, when there is no `children` (a search entry, a logo). */
  title?: string | undefined;
  /** What sits in the bar, left of WeChat's capsule. */
  children?: ReactNode;
  className?: string | undefined;
}

/** A real (device) px size as a design size in the page's units. */
function devicePx(size: number, windowWidth: number): string {
  return px(Math.round((size * 750) / windowWidth));
}

/**
 * The custom navigation bar of 首页 and 我的 (design.md §4.5; their page config sets
 * `navigationStyle: 'custom'`): as tall as the status bar plus WeChat's capsule row, fixed at
 * the top, with a placeholder of the same height so the page starts below it. White, like the
 * native bar on every other page.
 */
export function NavBar({ title, children, className }: NavBarProps) {
  const metrics = navBarMetrics();
  const total = devicePx(metrics.statusBarHeight + metrics.navBarHeight, metrics.windowWidth);
  return (
    <>
      <View
        className={cx('shop-nav-bar', className)}
        style={{ paddingTop: devicePx(metrics.statusBarHeight, metrics.windowWidth) }}
      >
        <View
          className="shop-nav-bar__row"
          style={{
            height: devicePx(metrics.navBarHeight, metrics.windowWidth),
            paddingRight: devicePx(metrics.capsuleWidth + 8, metrics.windowWidth),
          }}
        >
          {children ?? <Text className="shop-nav-bar__title">{title}</Text>}
        </View>
      </View>
      <View className="shop-nav-bar__placeholder" style={{ height: total }} ariaHidden />
    </>
  );
}
