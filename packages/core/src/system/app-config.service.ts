import type { LinkTarget } from '@shop/contracts/decor/link';
import type {
  AppAppearance,
  AppPublicConfig,
  AppSubscribeScene,
  AppTabBarItem,
  AppTabKey,
} from '@shop/contracts/system/app.schemas';
import {
  appAppearanceDefaults,
  MAX_SUBSCRIBE_TEMPLATES,
  webviewDomain,
} from '@shop/contracts/system/app.schemas';
import { deriveTheme } from '@shop/contracts/system/theme';

import type { Ctx } from '../kernel/context';
import { storageConfig, uploadsCdnOriginOf } from '../storage/index';
import {
  authOf,
  orNull,
  paymentsOf,
  siteConfigSourceGroups,
  supportOf,
  type SiteReadCtx,
} from './site.service';
import { siteConfig } from './site.config';
import {
  storefrontAppearanceConfig,
  type StorefrontAppearanceConfig,
} from './storefront-appearance.config';
import * as repo from './system.repo';
import { wechatMiniConfig, webviewDomainsOf } from './wechat-mini.config';

/**
 * `GET /api/v1/app/config` — the mini-program's launch payload.
 *
 * Built on the rules and the builders in `site.service.ts`: `supportOf`,
 * `paymentsOf` and `authOf` are called there, not copied here. (The old
 * `site/config` payload was deleted at the cutover.)
 *
 * Two things the payload carries belong to domains `system` may not import,
 * and they arrive the way the payment and sign-in flags do: the owner
 * registers a reader (`registerAppConfigSource`) from its own
 * `register<Domain>Domain()`, and this file only ever sees its answer.
 *
 * | Source | Owner | Group |
 * | --- | --- | --- |
 * | `subscribeTemplates` | `wechat-oa` | `wechat-oa-runtime` |
 * | `wechatRequiresPhone` | `user` | `storefront-auth` |
 *
 * Until a reader is registered the answer is the group's own default — no
 * template ids, and "a phone will be required" — so a process that never
 * installed the owner still answers something true of a fresh install.
 *
 * Cached 60 s in Redis under its own key and dropped from `configSave` when a
 * source group is saved (`invalidateAppConfigCache`); `version` is the newest
 * save across those groups and doubles as the weak `ETag`.
 *
 * `serverTime` is the one per-request value: it is stamped after the cache
 * (`tagged`), never stored in it, never part of `version`, and also sent as
 * the `X-Server-Time` header so a bodyless 304 carries it too.
 */

/**
 * v2: the payload grew `subscribeScenes`, `webviewDomains`, `accentColor`, a typed splash link.
 * v3: `subscribeTemplates.orderUnpaid`.
 * v4: `assetOrigin`.
 */
const CACHE_KEY = 'app:config:v4';
const CACHE_SECONDS = 60;

type SubscribeTemplatesByScene = AppPublicConfig['subscribeTemplates'];
/** What is built and cached: everything but the per-request clock. */
type CachedAppConfig = Omit<AppPublicConfig, 'serverTime'>;

export interface AppConfigSources {
  subscribeTemplates: {
    /** The config groups the answer is read from; saving one drops the cache. */
    groups: readonly string[];
    read: (ctx: Ctx) => Promise<SubscribeTemplatesByScene>;
  };
  wechatRequiresPhone: {
    groups: readonly string[];
    read: (ctx: Ctx) => Promise<boolean>;
  };
}

const sources: { [K in keyof AppConfigSources]?: AppConfigSources[K] } = {};

export function registerAppConfigSource<K extends keyof AppConfigSources>(
  key: K,
  source: AppConfigSources[K],
): void {
  sources[key] = source;
}

/** Test helper. Never call this from app code. */
export function resetAppConfigSources(): void {
  delete sources.subscribeTemplates;
  delete sources.wechatRequiresPhone;
}

/** The groups the payload is built from: the site's, the appearance, storage, and every registered reader's. */
export function appConfigSourceGroups(): string[] {
  const groups = new Set<string>([
    ...siteConfigSourceGroups(),
    storefrontAppearanceConfig.group,
    storageConfig.group,
  ]);
  for (const source of Object.values(sources)) for (const group of source.groups) groups.add(group);
  return [...groups];
}

export async function appConfigGet(ctx: SiteReadCtx): Promise<AppPublicConfig> {
  const hit = await readCache(ctx);
  if (hit !== null) return tagged(ctx, hit);

  const payload = await buildAppConfig(ctx);
  try {
    await ctx.redis.set(CACHE_KEY, JSON.stringify(payload), 'EX', CACHE_SECONDS);
  } catch (error) {
    ctx.logger.warn({ err: error, key: CACHE_KEY }, 'app: config cache write failed');
  }
  return tagged(ctx, payload);
}

/** Drops the cached payload when a group it is built from is saved. Called from `configSave`. */
export async function invalidateAppConfigCache(ctx: Ctx, group: string): Promise<void> {
  if (!appConfigSourceGroups().includes(group)) return;
  try {
    await ctx.redis.del(CACHE_KEY);
  } catch (error) {
    ctx.logger.warn({ err: error, key: CACHE_KEY }, 'app: config cache invalidation failed');
  }
}

function tagged(ctx: SiteReadCtx, payload: CachedAppConfig): AppPublicConfig {
  const serverTime = ctx.clock.now().toISOString();
  ctx.setHeader?.('ETag', `W/"${payload.version}"`);
  ctx.setHeader?.('Cache-Control', 'no-cache');
  ctx.setHeader?.('X-Server-Time', serverTime);
  return { ...payload, serverTime };
}

async function readCache(ctx: Ctx): Promise<CachedAppConfig | null> {
  try {
    const raw = await ctx.redis.get(CACHE_KEY);
    return raw === null ? null : (JSON.parse(raw) as CachedAppConfig);
  } catch (error) {
    ctx.logger.warn({ err: error, key: CACHE_KEY }, 'app: config cache read failed');
    return null;
  }
}

async function buildAppConfig(ctx: Ctx): Promise<CachedAppConfig> {
  const [
    site,
    mini,
    appearance,
    storage,
    payments,
    auth,
    subscribeTemplates,
    requiresPhone,
    version,
  ] = await Promise.all([
    ctx.config.get(siteConfig),
    ctx.config.get(wechatMiniConfig),
    ctx.config.get(storefrontAppearanceConfig),
    ctx.config.get(storageConfig),
    paymentsOf(ctx),
    authOf(ctx),
    subscribeTemplatesOf(ctx),
    wechatRequiresPhoneOf(ctx),
    versionOf(ctx),
  ]);

  return {
    name: site.siteName,
    logo: {
      main: orNull(site.logo),
      login: orNull(site.loginLogo),
      square: orNull(site.logoSquare),
      favicon: orNull(site.favicon),
    },
    share: {
      title: site.shareTitle,
      synopsis: site.shareSummary,
      image: orNull(site.shareImage),
    },
    support: supportOf(site, mini),
    auth: { ...auth, wechatRequiresPhone: requiresPhone },
    payments,
    splashAd: {
      enabled: site.splashEnabled && orNull(site.splashImage) !== null,
      imageUrl: orNull(site.splashImage),
      link: splashLinkOf(site.splashLinkTarget, site.splashLink),
      seconds: site.splashSeconds,
    },
    subscribeTemplates,
    subscribeScenes: subscribeScenesOf(subscribeTemplates),
    webviewDomains: webviewDomainsOf(mini.webviewDomains).filter(
      (domain) => webviewDomain.safeParse(domain).success,
    ),
    assetOrigin: uploadsCdnOriginOf(storage.uploadsCdnOrigin),
    appearance: appearanceOf(appearance),
    display: {
      categorySubcategories: appearance.showCategorySubcategories,
      productReviews: appearance.showProductReviews,
      productRecommendations: appearance.showProductRecommendations,
      productServiceTags: appearance.showProductServiceTags,
      productPoster: appearance.showProductPoster,
    },
    version,
  };
}

/**
 * A reader that throws is a `warn` and the empty answer, never a 500 — the
 * same discipline as the payment and sign-in probes: this is the first request
 * the app makes, and a broken template setting must not keep the shop dark.
 */
async function subscribeTemplatesOf(ctx: Ctx): Promise<SubscribeTemplatesByScene> {
  const none: SubscribeTemplatesByScene = {
    orderCreate: [],
    orderPay: [],
    orderUnpaid: [],
    orderShip: [],
    refund: [],
  };
  const source = sources.subscribeTemplates;
  if (!source) return none;
  try {
    return await source.read(ctx);
  } catch (error) {
    ctx.logger.warn({ err: error }, 'app: subscribe template reader failed');
    return none;
  }
}

/** Doubt resolves to `true`, the setting's own default: telling the shopper a phone is needed is the honest miss. */
async function wechatRequiresPhoneOf(ctx: Ctx): Promise<boolean> {
  const source = sources.wechatRequiresPhone;
  if (!source) return true;
  try {
    return await source.read(ctx);
  } catch (error) {
    ctx.logger.warn({ err: error }, 'app: phone-requirement reader failed');
    return true;
  }
}

/**
 * Which templates each tap asks for (C08), in the order they are asked, at
 * most three. An order's checkout asks for shipping first — the message a
 * shopper wants most — then the 未付款提醒 (only this tap can ask for it, and
 * it is what brings back an order left unpaid), then payment, then creation,
 * which the shopper is looking at as it happens and so is the first cut; the
 * three checkouts share that list. The after-sale taps ask for the refund
 * templates.
 *
 * The operator groups templates by message (`subscribeTemplates`); the pages
 * ask by tap. This is the one place the two meet, so no client carries it.
 */
export function subscribeScenesOf(
  templates: SubscribeTemplatesByScene,
): Record<AppSubscribeScene, string[]> {
  const pick = (...lists: string[][]) =>
    [...new Set(lists.flat().filter((id) => id.trim() !== ''))].slice(0, MAX_SUBSCRIBE_TEMPLATES);
  const order = () =>
    pick(templates.orderShip, templates.orderUnpaid, templates.orderPay, templates.orderCreate);
  return {
    checkout: order(),
    groupbuyCheckout: order(),
    presaleCheckout: order(),
    refundApply: pick(templates.refund),
    returnShipment: pick(templates.refund),
  };
}

/**
 * The splash's tap for the mini-program: the stored `LinkTarget`; failing
 * that, the legacy `splashLink` when it is an https URL (opened in the
 * web-view, where the client still checks the host, C12); otherwise `null`.
 * A legacy uni-app path is not guessed at: a wrong page is worse than none.
 */
export function splashLinkOf(target: LinkTarget | null, legacy: string): LinkTarget | null {
  if (target) return target;
  const url = legacy.trim();
  if (!/^https:\/\/[^\s]+$/i.test(url) || url.length > 2048) return null;
  try {
    new URL(url);
  } catch {
    return null;
  }
  return { kind: 'webview', url };
}

type TabField = Extract<keyof StorefrontAppearanceConfig, `tab${string}`>;

const TAB_FIELDS: Record<AppTabKey, { label: TabField; icon: TabField; selected: TabField }> = {
  home: { label: 'tabHomeLabel', icon: 'tabHomeIcon', selected: 'tabHomeSelectedIcon' },
  category: {
    label: 'tabCategoryLabel',
    icon: 'tabCategoryIcon',
    selected: 'tabCategorySelectedIcon',
  },
  cart: { label: 'tabCartLabel', icon: 'tabCartIcon', selected: 'tabCartSelectedIcon' },
  me: { label: 'tabMeLabel', icon: 'tabMeIcon', selected: 'tabMeSelectedIcon' },
};

/**
 * The stored group as the client reads it. Always the four tabs in their fixed
 * order; a blank label is the default label, a blank icon is `null` (bundled).
 */
export function appearanceOf(values: StorefrontAppearanceConfig): AppAppearance {
  const items = appAppearanceDefaults.tabBar.items.map((fallback): AppTabBarItem => {
    const fields = TAB_FIELDS[fallback.key];
    return {
      key: fallback.key,
      label: orNull(values[fields.label]) ?? fallback.label,
      iconUrl: orNull(values[fields.icon]),
      selectedIconUrl: orNull(values[fields.selected]),
    };
  });
  return {
    theme: {
      primaryColor: values.primaryColor,
      // Derived, not a setting: the mini picks the readable text colour for
      // the primary itself (`deriveTheme`), so a stored one was never used.
      // Still sent, because clients already in review parse it.
      primaryContrastColor: deriveTheme({ primary: values.primaryColor }).onPrimary,
      accentColor: orNull(values.accentColor),
      priceColor: values.priceColor,
      radius: values.radius,
    },
    tabBar: {
      color: values.tabBarColor,
      selectedColor: values.tabBarSelectedColor,
      backgroundColor: values.tabBarBackgroundColor,
      items,
    },
  };
}

/** Newest save across the source groups, in ms; `'0'` when nothing was ever saved. */
async function versionOf(ctx: Ctx): Promise<string> {
  const stamps = await Promise.all(
    appConfigSourceGroups().map((group) => repo.configGroupUpdatedAt(ctx.db, group)),
  );
  let newest = 0;
  for (const stamp of stamps) {
    if (stamp && stamp.getTime() > newest) newest = stamp.getTime();
  }
  return String(newest);
}
