import { useState, type ReactNode } from 'react';
import { Image as TaroImage, Text, View } from '@tarojs/components';
import { assetUrl } from '@/lib/asset-url';
import { cx } from '@/lib/cx';
import { navBarMetrics, px } from '@/platform';
import './nav-bar.scss';

export interface NavBarProps {
  /** The title, when there is no `children` (a search entry, a logo). */
  title?: string | undefined;
  /** What sits in the bar, left of WeChat's capsule. */
  children?: ReactNode;
  /** The bar's colour (首页's 顶部导航栏 setting); white, like the native bar, when absent. */
  background?: string | undefined;
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
 * native bar on every other page, unless the page names its own `background`.
 */
export function NavBar({ title, children, background, className }: NavBarProps) {
  const metrics = navBarMetrics();
  const total = devicePx(metrics.statusBarHeight + metrics.navBarHeight, metrics.windowWidth);
  return (
    <>
      <View
        className={cx('shop-nav-bar', className)}
        style={{
          paddingTop: devicePx(metrics.statusBarHeight, metrics.windowWidth),
          ...(background ? { background } : {}),
        }}
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

export interface NavBarLeadProps {
  /** The logo (an uploaded path or URL); the title stands in when absent or when it fails. */
  logo?: string | null | undefined;
  /** The title, and the logo's accessible name. */
  title: string;
  /** Something sits beside it (a search entry): the title then keeps to its own width. */
  beside?: boolean | undefined;
}

/**
 * What starts the bar: the logo, whole — its height fixed, its width following the picture
 * (`heightFix`), never cropped to a square — or else the title.
 */
export function NavBarLead({ logo, title, beside = false }: NavBarLeadProps) {
  const url = assetUrl(logo ?? null);
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url) {
    return (
      <Text className={cx('shop-nav-bar__title', beside && 'shop-nav-bar__title--lead')}>
        {title}
      </Text>
    );
  }
  return (
    <View className="shop-nav-bar__logo" ariaRole="img" ariaLabel={title}>
      <TaroImage
        className="shop-nav-bar__logo-image"
        src={url}
        mode="heightFix"
        onError={() => setFailed(url)}
      />
    </View>
  );
}
