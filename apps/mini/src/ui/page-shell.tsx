import type { ReactNode } from 'react';
import { NavigationBar, PageMeta, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { useThemeStyle } from '@/theme/store';
import { useOverlayStore } from './overlay-store';
import { PrivacySheet } from './privacy-sheet';
import './page-shell.scss';

const WEAPP = process.env.TARO_ENV === 'weapp';

export interface PageShellProps {
  /**
   * The native navigation bar's title. It is also how a page changes its title later (a
   * category name, an article title): pass the new one, no `setNavigationBarTitle` needed.
   */
  title: string;
  /** `page` (grey, the default: white cards on grey) or `surface` (white). */
  bg?: 'page' | 'surface';
  /** Leave room at the bottom for a fixed `ActionBar` / submit bar and the home indicator. */
  withBar?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * The outermost node of every page (docs/mini/design.md §3.1, §4.1).
 *
 * - `page-meta` first: the shop's theme as `--color-*` on the page root, so sheets and toasts
 *   under the root inherit it too; the page follows WeChat's font-size setting
 *   (`page-font-size="system"`). Every page config sets `enablePageMeta: true`, or Taro drops it.
 * - the global privacy sheet (C04), shown when WeChat asks for authorisation.
 *
 * The H5 build (dev and e2e only) has no page-meta: Taro's H5 stub logs an error for it. There
 * the theme is written on the page wrapper instead.
 */
export function PageShell({
  title,
  bg = 'page',
  withBar = false,
  className,
  children,
}: PageShellProps) {
  const themeStyle = useThemeStyle();
  const locked = useOverlayStore((state) => state.open > 0);
  const pageStyle = [themeStyle, locked ? 'overflow:hidden' : ''].filter(Boolean).join(';');
  return (
    <>
      {WEAPP ? (
        <PageMeta pageStyle={pageStyle} pageFontSize="system" rootFontSize="system">
          <NavigationBar title={title} frontColor="#000000" backgroundColor="#ffffff" />
        </PageMeta>
      ) : null}
      <View
        className={cx(
          'shop-page',
          bg === 'surface' && 'shop-page--surface',
          withBar && 'shop-page--bar',
          className,
        )}
        {...(WEAPP ? {} : { style: themeStyle })}
      >
        {children}
      </View>
      <PrivacySheet />
    </>
  );
}
