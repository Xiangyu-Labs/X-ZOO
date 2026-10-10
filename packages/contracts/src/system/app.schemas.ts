import { z } from 'zod';
import { instant } from '../_conventions/common';
import { linkTarget } from '../decor/link';
import { sitePublicConfig, sitePublicConfigExample } from './schemas';

/**
 * `GET /api/v1/app/config` — everything the mini-program needs before its
 * first screen, in one payload.
 *
 * It replaced `GET /api/v1/site/config` (deleted at the cutover), reusing its
 * schema pieces (`sitePublicConfig`) — no H5 footer (`filing`, `copyright`),
 * plus the three things the client would otherwise fetch on launch one by one:
 * the subscribe-message template ids, the theme, and the tab bar.
 *
 * Every value is a non-secret config field or a boolean derived from one; the
 * "cannot leak any secret in any registered group" property is asserted for
 * this payload (SYS-014).
 */

/**
 * `#RRGGBB`, the one colour form every consumer accepts.
 *
 * There is no colour field kind in the config registry, so a colour is a text
 * field validated by this. Six digits only: the mini-program's native
 * `tabBar.color` and `wx.setTabBarStyle` take `#RRGGBB` and nothing else, and
 * a theme token the tab bar cannot use would be a second rule to remember.
 */
export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色格式应为 #RRGGBB');
export type HexColor = z.infer<typeof hexColor>;

/**
 * Corner-radius scale. A choice rather than a pixel value: the client owns the
 * actual steps (buttons, cards and the price tag each round differently), the
 * shop only picks how round the whole app feels.
 */
export const radiusScale = z.enum(['none', 'small', 'medium', 'large']);
export type RadiusScale = z.infer<typeof radiusScale>;

/** The four fixed tabs, in the order they appear. */
export const appTabKey = z.enum(['home', 'category', 'cart', 'me']);
export type AppTabKey = z.infer<typeof appTabKey>;

export const appTabBarItem = z.object({
  key: appTabKey,
  /** Never empty: a blank label on the settings screen falls back to the default. */
  label: z.string().min(1),
  /** An uploaded icon, or `null` for the client's bundled one. */
  iconUrl: z.string().nullable(),
  selectedIconUrl: z.string().nullable(),
});
export type AppTabBarItem = z.infer<typeof appTabBarItem>;

export const appAppearance = z.object({
  theme: z.object({
    primaryColor: hexColor,
    /**
     * Text and icons drawn on top of `primaryColor` (buttons, badges). Derived
     * from `primaryColor` by `deriveTheme`, the same as the mini computes it;
     * no longer an operator setting.
     */
    primaryContrastColor: hexColor,
    /**
     * 辅助色 (design.md §3.2): gradient starts, the 加入购物车 button beside the
     * primary one. `null` = none set, which the client reads as "the primary
     * colour" (a one-colour scheme); `deriveTheme` does exactly that.
     */
    accentColor: hexColor.nullable(),
    priceColor: hexColor,
    radius: radiusScale,
  }),
  tabBar: z.object({
    color: hexColor,
    selectedColor: hexColor,
    backgroundColor: hexColor,
    /** Always exactly the four fixed tabs, in `appTabKey` order. */
    items: z.array(appTabBarItem).length(4),
  }),
});
export type AppAppearance = z.infer<typeof appAppearance>;

/**
 * Which optional parts of two fixed pages show (the `storefront-appearance`
 * group's 页面显示 switches). Every one defaults to `true`, which is what those
 * pages showed before the switches existed.
 */
export const appDisplay = z.object({
  /** 分类: the second-level categories under the selected top-level one. */
  categorySubcategories: z.boolean(),
  /** 商品详情: the review summary and first reviews. */
  productReviews: z.boolean(),
  /** 商品详情: 为你推荐. */
  productRecommendations: z.boolean(),
  /** 商品详情: the 服务 row and its sheet. */
  productServiceTags: z.boolean(),
  /**
   * 商品详情: 生成海报 in the share sheet. Off hides the poster only; sending
   * the page to a WeChat friend stays. The 拼团 invite poster is not covered.
   */
  productPoster: z.boolean(),
});
export type AppDisplay = z.infer<typeof appDisplay>;

export const appDisplayDefaults: AppDisplay = {
  categorySubcategories: true,
  productReviews: true,
  productRecommendations: true,
  productServiceTags: true,
  productPoster: true,
};

/** Template ids, deduplicated, in the operator's order; `[]` when none are set. */
const templateIds = z.array(z.string());

/**
 * The taps that ask for subscribe messages (wechat-compliance.md C08). The
 * mini-program calls `subscribe(scene)` with one of these inside the tap
 * handler; `subscribeScenes` says which template ids that asks for.
 */
export const appSubscribeScene = z.enum([
  'checkout',
  'groupbuyCheckout',
  'presaleCheckout',
  'refundApply',
  'returnShipment',
]);
export type AppSubscribeScene = z.infer<typeof appSubscribeScene>;

/** `wx.requestSubscribeMessage` takes at most this many template ids per call. */
export const MAX_SUBSCRIBE_TEMPLATES = 3;

/** One scene's ids: non-empty, deduplicated, at most three, in the order to ask. */
const sceneTemplateIds = z.array(z.string().min(1)).max(MAX_SUBSCRIBE_TEMPLATES);

/**
 * The splash for the mini-program. The same switch, picture and seconds as
 * `sitePublicConfig`'s, but the tap target is a `LinkTarget` (decor contracts),
 * not a legacy uni-app path: the mini-program resolves it through the route
 * catalogue like any decorated link. `null` = the splash is not tappable.
 */
export const appSplashAd = sitePublicConfig.shape.splashAd.extend({
  link: linkTarget.nullable(),
});
export type AppSplashAd = z.infer<typeof appSplashAd>;

/** A bare host name, lower-case: `shop.example.com`, never a scheme, port or path. */
export const webviewDomain = z
  .string()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    '业务域名只填主机名，例如 shop.example.com',
  );

export const appPublicConfig = z.object({
  name: sitePublicConfig.shape.name,
  logo: sitePublicConfig.shape.logo,
  share: sitePublicConfig.shape.share,
  support: sitePublicConfig.shape.support,
  /**
   * Which sign-in methods to offer — the probes `registerSiteAuthMethod`
   * installs — plus `wechatRequiresPhone`: whether a first WeChat sign-in will
   * answer `phone-required` (商城登录 → 微信登录强制绑定手机号). The client
   * still branches on the sign-in response; this only lets it say so up front.
   */
  auth: sitePublicConfig.shape.auth.extend({ wechatRequiresPhone: z.boolean() }),
  payments: sitePublicConfig.shape.payments,
  splashAd: appSplashAd,
  /**
   * Subscribe-message template ids per scene, for `wx.requestSubscribeMessage`
   * — the same values `GET /api/v1/wechat/subscribe-templates?scene=` answers,
   * all five at once. Keys are the scenes in camelCase: `order-create` →
   * `orderCreate`.
   *
   * @deprecated for the mini-program: read `subscribeScenes`, which is built
   * from these on the server. Kept because the lists are the settings as the
   * operator grouped them, and a client already in the field reads them.
   */
  subscribeTemplates: z.object({
    orderCreate: templateIds,
    orderPay: templateIds,
    /** 未付款提醒: asked for at 提交订单, sent shortly before an unpaid order is cancelled. */
    orderUnpaid: templateIds,
    orderShip: templateIds,
    refund: templateIds,
  }),
  /**
   * What each tap asks for (C08), at most three ids each, built on the server
   * from `subscribeTemplates` so no client keeps the mapping. A scene with no
   * ids is `[]`: the client then skips the prompt.
   */
  subscribeScenes: z.object({
    checkout: sceneTemplateIds,
    groupbuyCheckout: sceneTemplateIds,
    presaleCheckout: sceneTemplateIds,
    refundApply: sceneTemplateIds,
    returnShipment: sceneTemplateIds,
  }),
  /**
   * The shop's 业务域名 (C12): a `web-view` may open an https page on one of
   * these hosts. `mp.weixin.qq.com` (the linked OA's articles) is always
   * allowed and is not listed. Lower-case, deduplicated; `[]` when none.
   */
  webviewDomains: z.array(webviewDomain),
  /**
   * Where an uploaded file's path (`/uploads/…`) loads from: a CDN's https
   * origin, `https://img.example.com`, lower-case, no trailing slash (存储设置 ›
   * 图片 CDN 域名). `null` = the API origin, as before there was a setting.
   * Absolute URLs (an S3 bucket's) are used as they are either way.
   */
  assetOrigin: z.string().nullable(),
  appearance: appAppearance,
  display: appDisplay,
  /** Moves whenever any source group is saved; also the weak `ETag`. */
  version: z.string(),
  /**
   * The server's clock when this answer was sent, for countdown drift
   * (design.md §4.4). **Not part of `version`/the `ETag`**: it changes on
   * every request, so it is added after the cache and a 304 stays a 304. A
   * 304 has no body, so the same instant also goes out as the
   * `X-Server-Time` header on every answer, 200 and 304 alike.
   */
  serverTime: instant,
});
export type AppPublicConfig = z.infer<typeof appPublicConfig>;

/** What a fresh install answers: the appearance defaults, nothing configured. */
export const appAppearanceDefaults: AppAppearance = {
  theme: {
    primaryColor: '#E93323',
    primaryContrastColor: '#FFFFFF',
    accentColor: null,
    priceColor: '#E93323',
    radius: 'medium',
  },
  tabBar: {
    color: '#282828',
    selectedColor: '#E93323',
    backgroundColor: '#FFFFFF',
    items: [
      { key: 'home', label: '首页', iconUrl: null, selectedIconUrl: null },
      { key: 'category', label: '分类', iconUrl: null, selectedIconUrl: null },
      { key: 'cart', label: '购物车', iconUrl: null, selectedIconUrl: null },
      { key: 'me', label: '我的', iconUrl: null, selectedIconUrl: null },
    ],
  },
};

export const appPublicConfigExample: AppPublicConfig = {
  name: sitePublicConfigExample.name,
  logo: sitePublicConfigExample.logo,
  share: sitePublicConfigExample.share,
  support: { kind: 'mini-program', phone: '400-000-0000', qrcodeUrl: null },
  auth: { wechatOa: false, wechatMini: true, phone: true, wechatRequiresPhone: true },
  payments: { wechat: true },
  splashAd: {
    ...sitePublicConfigExample.splashAd,
    link: { kind: 'product', id: '12' },
  },
  subscribeTemplates: {
    orderCreate: [],
    orderPay: ['kL9x2fP0bQ-order-paid-3a7c'],
    orderUnpaid: [],
    orderShip: ['kL9x2fP0bQ-shipped-51de', 'kL9x2fP0bQ-delivered-9b02'],
    refund: ['kL9x2fP0bQ-refund-e4f1'],
  },
  subscribeScenes: {
    checkout: [
      'kL9x2fP0bQ-shipped-51de',
      'kL9x2fP0bQ-delivered-9b02',
      'kL9x2fP0bQ-order-paid-3a7c',
    ],
    groupbuyCheckout: [
      'kL9x2fP0bQ-shipped-51de',
      'kL9x2fP0bQ-delivered-9b02',
      'kL9x2fP0bQ-order-paid-3a7c',
    ],
    presaleCheckout: [
      'kL9x2fP0bQ-shipped-51de',
      'kL9x2fP0bQ-delivered-9b02',
      'kL9x2fP0bQ-order-paid-3a7c',
    ],
    refundApply: ['kL9x2fP0bQ-refund-e4f1'],
    returnShipment: ['kL9x2fP0bQ-refund-e4f1'],
  },
  webviewDomains: ['shop.example.com'],
  assetOrigin: 'https://img.example.com',
  appearance: {
    theme: {
      primaryColor: '#1677FF',
      primaryContrastColor: '#FFFFFF',
      accentColor: '#FF7E00',
      priceColor: '#FF4D4F',
      radius: 'large',
    },
    tabBar: {
      color: '#666666',
      selectedColor: '#1677FF',
      backgroundColor: '#FFFFFF',
      items: [
        {
          key: 'home',
          label: '首页',
          iconUrl: '/uploads/attach/2026/09/tab-home.png',
          selectedIconUrl: '/uploads/attach/2026/09/tab-home-on.png',
        },
        { key: 'category', label: '分类', iconUrl: null, selectedIconUrl: null },
        { key: 'cart', label: '购物车', iconUrl: null, selectedIconUrl: null },
        { key: 'me', label: '我的', iconUrl: null, selectedIconUrl: null },
      ],
    },
  },
  display: { ...appDisplayDefaults, productRecommendations: false, productPoster: false },
  version: '1758500000000',
  serverTime: '2026-09-24T08:00:00.000+08:00',
};
