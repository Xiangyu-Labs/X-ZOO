import { z } from 'zod';
import { linkTarget } from '@shop/contracts/decor/link';
import type { Ctx } from '../kernel/context';
import { defineConfigGroup } from '../kernel/config-registry';
import { originFromEnv, trimOrigin } from '../kernel/origin';

/**
 * `site` — the shop's own identity: name, logos, filing numbers, contact and
 * the defaults used when a page is shared into WeChat.
 *
 * The site URL is **not** here: the deployment takes the origin from the
 * environment, where it belongs (see `publicOrigin` below).
 *
 * Every field has a `.default()`, without exception — `defineConfigGroup`
 * refuses a group that cannot be read before anybody has saved it, because a
 * fresh install has to boot.
 */

export const siteConfig = defineConfigGroup({
  group: 'site',
  title: '站点设置',
  description: '商城名称、Logo、备案信息、分享卡片与开屏广告。',
  category: 'basic',
  permission: 'system:config:read',
  schema: z.object({
    siteName: z.string().max(64).default('X-ZOO商城'),
    siteKeywords: z.string().max(255).default(''),
    siteDescription: z.string().max(500).default(''),
    contactPhone: z.string().max(32).default(''),
    companyAddress: z.string().max(255).default(''),

    logo: z.string().max(512).default(''),
    logoSquare: z.string().max(512).default(''),
    loginLogo: z.string().max(512).default(''),
    favicon: z.string().max(512).default(''),

    /** 备案号, shown in the storefront footer next to `icpUrl`. */
    icpNumber: z.string().max(64).default(''),
    icpUrl: z.string().max(255).default('https://beian.miit.gov.cn/'),
    /** 公安备案号 and the link it points at. */
    publicSecurityNumber: z.string().max(64).default(''),
    publicSecurityUrl: z.string().max(255).default(''),

    /** Customer-service QR code shown on the 联系我们 page. */
    contactQrcode: z.string().max(512).default(''),
    /** The shop's own QR code, for posters. */
    shareQrcode: z.string().max(512).default(''),

    shareTitle: z.string().max(64).default(''),
    shareSummary: z.string().max(255).default(''),
    shareImage: z.string().max(512).default(''),

    /**
     * 版权 — the footer line every storefront page renders.
     *
     * A fresh install has nothing here and the footer is empty. `copyrightLink`
     * exists because an operator who writes a company name almost always wants
     * it to go somewhere.
     */
    copyrightText: z.string().max(255).default(''),
    copyrightLink: z.string().max(255).default(''),
    copyrightImage: z.string().max(512).default(''),

    /**
     * 开屏广告 — `pages/guide` shows this before the home page, once a day.
     *
     * One image with a link and a countdown is what the screen renders, so
     * that is what is stored.
     *
     * `splashEnabled` is the switch on its own, rather than "an image means
     * on": an operator who is preparing next week's campaign needs somewhere
     * to put the image that is not live.
     */
    splashEnabled: z.boolean().default(false),
    splashImage: z.string().max(512).default(''),
    splashLink: z.string().max(255).default(''),
    /**
     * The same tap for the mini-program, as a `LinkTarget` (decor contracts):
     * `GET /api/v1/app/config` serves it. `null` falls back to `splashLink`
     * when that is an https URL (a `webview` link) and to "not tappable"
     * otherwise — a legacy uni-app path means nothing to the mini-program.
     */
    splashLinkTarget: linkTarget.nullable().default(null),
    /** How long the splash stays up before it falls through to the home page. */
    splashSeconds: z.number().int().min(1).max(30).default(3),

    /**
     * Absolute public origin, no trailing slash, e.g. `https://shop.example.com`.
     *
     * Environment-derived and **not** an operator setting: it is a deployment
     * fact, and a stored copy goes stale the day the shop moves domains,
     * leaving the old origin (or `http://localhost`) in every WeChat link. Its
     * `ui` entry is `readOnly`, so the settings screen shows the current value
     * as plain text and `configSave` refuses the key.
     *
     * Empty is the safe default: with no origin an outbound link is dropped
     * rather than sent as a bare path, and `isTrustedHost` trusts nothing.
     */
    publicOrigin: z
      .string()
      .max(255)
      .default(() => originFromEnv()),
    /**
     * Extra hosts also served by this deployment, comma-separated. Same source
     * of truth: `EXTRA_ALLOWED_ORIGINS`, which the web app already parses for
     * the CSRF check, so a staging domain is listed once.
     *
     * This is *not* where an operator lists 公众号 JS 安全域名 — that stays
     * editable in `wechat-oa-runtime.jsApiAllowedHosts`, because it is a
     * statement about the WeChat account rather than about this deployment.
     */
    extraOrigins: z
      .string()
      .max(500)
      .default(() => (process.env['EXTRA_ALLOWED_ORIGINS'] ?? '').trim()),
  }),
  ui: {
    siteName: { label: '商城名称', type: 'text', section: '基础', order: 1 },
    siteKeywords: { label: '站点关键词', type: 'text', section: '基础', order: 2 },
    siteDescription: { label: '站点描述', type: 'textarea', section: '基础', order: 3 },
    contactPhone: { label: '联系电话', type: 'text', section: '基础', order: 4 },
    companyAddress: { label: '公司地址', type: 'text', section: '基础', order: 5 },

    // Each help says where the picture shows up, because the four names alone
    // do not: an operator who uploads a 方形 Logo expecting the mini-program's
    // home page to change needs to be told it will not.
    logo: {
      label: '后台 Logo',
      type: 'image',
      section: 'Logo',
      help: '后台左上角（侧栏展开时）和后台登录页。建议 170×50 横版透明底。不填则显示默认图标 + 商城名称',
      order: 10,
    },
    logoSquare: {
      label: '方形 Logo',
      type: 'image',
      section: 'Logo',
      help: '后台侧栏收起时的图标；小程序登录页没设置「登录页 Logo」时的替补。小程序首页顶栏不用它，首页 Logo 在 装修 → 页面设置 → 顶部导航栏',
      order: 11,
    },
    loginLogo: {
      label: '登录页 Logo',
      type: 'image',
      section: 'Logo',
      help: '小程序登录页顶部（圆形裁切）',
      order: 12,
    },
    favicon: {
      label: '浏览器图标',
      type: 'image',
      section: 'Logo',
      help: '后台网页标签页上的小图标，建议 32×32 或 64×64 的 PNG/ICO',
      order: 13,
    },

    icpNumber: { label: 'ICP 备案号', type: 'text', section: '备案', order: 20 },
    icpUrl: { label: 'ICP 备案链接', type: 'text', section: '备案', order: 21 },
    publicSecurityNumber: { label: '公安备案号', type: 'text', section: '备案', order: 22 },
    publicSecurityUrl: { label: '公安备案链接', type: 'text', section: '备案', order: 23 },

    contactQrcode: { label: '客服二维码', type: 'image', section: '二维码', order: 30 },
    shareQrcode: { label: '商城二维码', type: 'image', section: '二维码', order: 31 },

    shareTitle: { label: '分享标题', type: 'text', section: '分享', order: 40 },
    shareSummary: { label: '分享简介', type: 'textarea', section: '分享', order: 41 },
    shareImage: {
      label: '分享图片',
      type: 'image',
      section: '分享',
      help: '比例 5:4，建议小于 50KB',
      order: 42,
    },

    copyrightText: { label: '版权文字', type: 'text', section: '版权', order: 50 },
    copyrightLink: {
      label: '版权链接',
      type: 'text',
      section: '版权',
      help: '留空则版权文字不可点击',
      order: 51,
    },
    copyrightImage: { label: '版权图片', type: 'image', section: '版权', order: 52 },

    splashEnabled: { label: '启用开屏广告', type: 'switch', section: '开屏广告', order: 60 },
    splashImage: {
      label: '开屏图片',
      type: 'image',
      section: '开屏广告',
      visibleWhen: { key: 'splashEnabled', equals: true },
      order: 61,
    },
    splashLink: {
      label: '点击跳转',
      type: 'text',
      section: '开屏广告',
      visibleWhen: { key: 'splashEnabled', equals: true },
      order: 62,
    },
    splashLinkTarget: {
      label: '点击跳转（小程序）',
      type: 'json',
      section: '开屏广告',
      help: '例如 {"kind":"product","id":"12"}；留空时，上面的跳转地址是 https 链接则在小程序内以网页打开，否则不可点击',
      visibleWhen: { key: 'splashEnabled', equals: true },
      order: 63,
    },
    splashSeconds: {
      label: '停留时间',
      type: 'number',
      unit: 'seconds',
      section: '开屏广告',
      visibleWhen: { key: 'splashEnabled', equals: true },
      order: 64,
    },

    // Shown, but nobody's here to change. Leaving them off the screen entirely
    // would be worse: an operator whose WeChat links point at the wrong host
    // needs to see *which* host the shop thinks it is before they can go and
    // fix the variable that says so.
    publicOrigin: {
      label: '站点域名',
      type: 'text',
      section: '部署',
      readOnly: true,
      source: 'env:PUBLIC_ORIGIN',
      order: 70,
    },
    extraOrigins: {
      label: '其他域名',
      type: 'text',
      section: '部署',
      readOnly: true,
      source: 'env:EXTRA_ALLOWED_ORIGINS',
      order: 71,
    },
  },
});

/**
 * The origin the storefront is served from, or `''`.
 *
 * Three things need it and none can work it out: a notification link
 * (`/orders/1024` has to become something a WeChat web view can open), the
 * JS-SDK signature endpoint, and anything later that composes an absolute URL
 * for a poster or a share card. A request's `Host` header answers none of them
 * — the effect dispatcher runs in the worker with no request at all, and for
 * the JS-SDK case trusting `Host` is the hole being closed.
 *
 * `''` is a real answer and every caller must handle it: it means nobody told
 * this deployment its own address, and guessing is worse than abstaining.
 */
export async function publicOrigin(ctx: Ctx): Promise<string> {
  const config = await ctx.config.get(siteConfig);
  return trimOrigin(config.publicOrigin);
}

/**
 * Whether a host is one this deployment serves.
 *
 * The comparison is on the **host**, never on a prefix: `shop.example.com`
 * must not match `shop.example.com.attacker.test`. An entry may be written as
 * a bare host or as a whole origin, because operators paste both. Nothing is
 * trusted when nothing is configured, which is why an unconfigured shop signs
 * no JS-SDK URLs rather than signing every one of them.
 */
export async function isTrustedHost(ctx: Ctx, host: string): Promise<boolean> {
  const wanted = hostOf(host);
  if (wanted === '') return false;
  const config = await ctx.config.get(siteConfig);
  const trusted = new Set<string>();
  for (const entry of [config.publicOrigin, ...config.extraOrigins.split(',')]) {
    const value = hostOf(entry);
    if (value !== '') trusted.add(value);
  }
  return trusted.has(wanted);
}

/**
 * The host of `https://shop.example.com/x`, of `shop.example.com:8443` and of
 * `shop.example.com` alike; `''` for anything that is neither.
 */
function hostOf(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === '') return '';
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).host;
  } catch {
    // A misconfigured entry must never become "trust everything".
    return '';
  }
}
