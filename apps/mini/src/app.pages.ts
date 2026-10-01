/**
 * Every page of the mini-program and the package it ships in (docs/mini/pages.md §1–2).
 * `app.config.ts` builds `pages`, `subPackages` and `preloadRule` from this; `app.pages.test.ts`
 * holds it equal to the route catalogue (`@shop/api-client/routes`), so a key and its page
 * cannot drift apart.
 *
 * Read by the Taro config compiler as well as bundled: no runtime imports.
 */
import { TAB_PAGES } from './platform/tab-pages';

/** Main package: the four tabs, product detail, login and the agreement page. */
export const MAIN_PAGES: readonly string[] = [
  ...TAB_PAGES.map((tab) => tab.pagePath),
  'pages/product/index',
  'pages/login/index',
  'pages/agreement/index',
];

export interface SubPackage {
  root: string;
  name: string;
  pages: readonly string[];
  /** Dev and H5 builds only: never in a production weapp build (app.config.ts). */
  devOnly?: true;
}

export const SUB_PACKAGES: readonly SubPackage[] = [
  {
    root: 'packages/goods',
    name: 'goods',
    pages: ['list/index', 'search/index', 'featured/index', 'reviews/index'],
  },
  {
    root: 'packages/order',
    name: 'order',
    pages: [
      'checkout/index',
      'cashier/index',
      'pay-result/index',
      'list/index',
      'detail/index',
      'logistics/index',
      'review/index',
    ],
  },
  {
    root: 'packages/aftersale',
    name: 'aftersale',
    pages: ['apply/index', 'list/index', 'detail/index', 'return-shipment/index'],
  },
  {
    root: 'packages/promo',
    name: 'promo',
    pages: [
      'groupbuy/index',
      'groupbuy-detail/index',
      'groupbuy-team/index',
      'presale/index',
      'presale-detail/index',
      'coupons/index',
      'my-coupons/index',
      'my-groupbuys/index',
    ],
  },
  {
    root: 'packages/account',
    name: 'account',
    pages: [
      'profile/index',
      'settings/index',
      'phone/index',
      'password/index',
      'password-reset/index',
      'addresses/index',
      'address-edit/index',
      'favorites/index',
      'history/index',
      'messages/index',
      'message/index',
      'invoices/index',
      'invoice-title-edit/index',
      'invoice/index',
      'invoice-apply/index',
      'cancellation/index',
      'reviews/index',
    ],
  },
  {
    root: 'packages/content',
    name: 'content',
    pages: ['articles/index', 'article/index', 'webview/index'],
  },
  { root: 'packages/page', name: 'page', pages: ['index'] },
  {
    // The UI kit gallery and spike S3's editor-canvas pixel fixture.
    root: 'subpackages/demo',
    name: 'demo',
    pages: ['pages/ui/index', 'pages/blocks/index'],
    devOnly: true,
  },
];

/**
 * Sub-packages fetched in the background once a page shows (C13), so the next tap does not
 * wait for a download. Network `all`: the packages are small and the next step is likely.
 */
export const PRELOAD_RULES: Readonly<Record<string, readonly string[]>> = {
  'pages/index/index': ['goods'],
  'pages/category/index': ['goods'],
  'pages/product/index': ['order'],
  'pages/cart/index': ['order'],
  'pages/me/index': ['order', 'account'],
};
