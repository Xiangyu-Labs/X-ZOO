/**
 * The storefront route catalogue: every page of the mini-program a stored link
 * may point at, as a stable key plus typed params (docs/mini/pages.md §3).
 *
 * Mini-program codes, subscribe-message `page`s, poster codes, in-app message
 * links, DIY `LinkTarget.route`, `set_msg_jump_path`, share paths and
 * customer-service card paths store `{ route, params }`, never a path string,
 * so a page can move without breaking data that is already saved.
 *
 * KEYS ARE APPEND-ONLY. Once a key has shipped it is never renamed and never
 * removed: saved links, printed codes and old clients all refer to it. A page
 * that goes away keeps its key and points it at a page that still exists. A
 * param may be added only as optional. New keys go at the end of the table.
 *
 * The mini-program does not load this file (it carries zod). `pnpm gen` writes a
 * zod-free copy of the table for it: `@shop/api-client/routes`
 * (`packages/api-client/scripts/gen-storefront-routes.ts`).
 */
import { z } from 'zod';
import { id } from '../_conventions/common';
import { orderListTab } from '../order/schemas';
import { agreementKey } from './schemas';

/** What the share menu offers on a page (C10). */
export type StorefrontShare = 'none' | 'friend' | 'friend+timeline';

/** Params travel as query-string values, so every param is a string. */
type ParamsSchema = z.ZodType<Readonly<Record<string, string | undefined>>>;

export interface StorefrontRouteDef<P extends ParamsSchema = ParamsSchema> {
  /** Mini-program page path, no leading `/`. Unique across the catalogue. */
  path: string;
  params: P;
  /**
   * A tabBar page. `switchTab` cannot carry a query, so `toMiniPath` never
   * adds one: the client's `navigate()` puts the params in the in-memory
   * `pendingTabParams` store, then switches; the page reads and clears them in
   * `useDidShow`.
   */
  tab?: true;
  share: StorefrontShare;
  /** A mini-program code may open it; the scene carries the params (`encodeScene`). */
  miniCode?: true;
  /** May be chosen as a DIY `LinkTarget.route` and in the admin LinkPicker. */
  linkable?: true;
  /** May be the target of a subscribe message or an in-app message. */
  notify?: true;
}

const none = z.strictObject({});
const optionalId = id.optional();

/** WeChat Pay `out_trade_no`: 6–32 of `[0-9A-Za-z_-|*]`. */
const outTradeNo = z.string().regex(/^[0-9A-Za-z_\-|*]{6,32}$/, '支付单号格式不正确');

/**
 * `login.redirect`: a JSON-encoded `StorefrontRoute`, never a path, so the
 * login page cannot be used as an open redirect. It may not point back at
 * `login`.
 */
const loginRedirect = z.string().max(1024).refine(isLoginRedirect, '登录后跳转的目标不正确');

function isLoginRedirect(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  const result = storefrontRoute.safeParse(parsed);
  return result.success && result.data.route !== 'login';
}

function defineRoutes<const T extends Record<string, StorefrontRouteDef>>(routes: T): T {
  return routes;
}

export const storefrontRoutes = defineRoutes({
  // -- main package -----------------------------------------------------------
  home: {
    path: 'pages/index/index',
    params: none,
    tab: true,
    share: 'friend+timeline',
    miniCode: true,
    linkable: true,
    notify: true,
  },
  category: {
    path: 'pages/category/index',
    params: z.strictObject({ categoryId: optionalId }),
    tab: true,
    share: 'friend',
    linkable: true,
  },
  cart: { path: 'pages/cart/index', params: none, tab: true, share: 'none', linkable: true },
  me: { path: 'pages/me/index', params: none, tab: true, share: 'none', linkable: true },
  product: {
    path: 'pages/product/index',
    params: z.strictObject({ id }),
    share: 'friend+timeline',
    miniCode: true,
    linkable: true,
    notify: true,
  },
  login: {
    path: 'pages/login/index',
    // `mode: 'sms'`: open on the SMS form (a 「短信验证码登录」 link elsewhere).
    params: z.strictObject({
      redirect: loginRedirect.optional(),
      mode: z.enum(['sms']).optional(),
    }),
    share: 'none',
  },
  agreement: {
    path: 'pages/agreement/index',
    params: z.strictObject({ key: agreementKey }),
    share: 'none',
    linkable: true,
  },

  // -- goods ------------------------------------------------------------------
  productList: {
    path: 'packages/goods/list/index',
    params: z.strictObject({
      categoryId: optionalId,
      keyword: z.string().min(1).max(64).optional(),
      labelId: optionalId,
      couponId: optionalId,
    }),
    share: 'friend',
    linkable: true,
  },
  search: {
    path: 'packages/goods/search/index',
    params: z.strictObject({ keyword: z.string().min(1).max(64).optional() }),
    share: 'none',
    linkable: true,
  },
  featured: {
    path: 'packages/goods/featured/index',
    params: z.strictObject({ tab: z.enum(['hot', 'new', 'best', 'benefit']).optional() }),
    share: 'friend',
    linkable: true,
  },
  productReviews: {
    path: 'packages/goods/reviews/index',
    params: z.strictObject({ productId: id }),
    share: 'none',
  },

  // -- order ------------------------------------------------------------------
  /** The draft lives in the in-memory `checkoutDraft` store, never in the URL. */
  checkout: { path: 'packages/order/checkout/index', params: none, share: 'none' },
  cashier: {
    path: 'packages/order/cashier/index',
    params: z.strictObject({ orderId: id }),
    share: 'none',
    notify: true,
  },
  payResult: {
    path: 'packages/order/pay-result/index',
    params: z.strictObject({ orderId: id, outTradeNo: outTradeNo.optional() }),
    share: 'none',
  },
  orderList: {
    path: 'packages/order/list/index',
    params: z.strictObject({ tab: orderListTab.optional() }),
    share: 'none',
    linkable: true,
    notify: true,
  },
  /** By `id`, or by `outTradeNo` (WeChat's shipping-message jump, C07): exactly one. */
  order: {
    path: 'packages/order/detail/index',
    params: z.union([z.strictObject({ id }), z.strictObject({ outTradeNo })]),
    share: 'none',
    notify: true,
  },
  logistics: {
    path: 'packages/order/logistics/index',
    params: z.strictObject({ orderId: id, shipmentId: optionalId }),
    share: 'none',
    notify: true,
  },
  reviewWrite: {
    path: 'packages/order/review/index',
    params: z.strictObject({ orderId: id, orderItemId: optionalId }),
    share: 'none',
    notify: true,
  },

  // -- aftersale --------------------------------------------------------------
  refundApply: {
    path: 'packages/aftersale/apply/index',
    params: z.strictObject({ orderId: id, orderItemId: optionalId }),
    share: 'none',
  },
  refundList: {
    path: 'packages/aftersale/list/index',
    params: z.strictObject({ state: z.enum(['all', 'open', 'succeeded', 'closed']).optional() }),
    share: 'none',
    linkable: true,
    notify: true,
  },
  refund: {
    path: 'packages/aftersale/detail/index',
    params: z.strictObject({ id }),
    share: 'none',
    notify: true,
  },
  refundReturnShipment: {
    path: 'packages/aftersale/return-shipment/index',
    params: z.strictObject({ id }),
    share: 'none',
    notify: true,
  },

  // -- promo ------------------------------------------------------------------
  groupbuyList: {
    path: 'packages/promo/groupbuy/index',
    params: none,
    share: 'friend',
    linkable: true,
  },
  /** `id` is the campaign. */
  groupbuy: {
    path: 'packages/promo/groupbuy-detail/index',
    params: z.strictObject({ id }),
    share: 'friend+timeline',
    miniCode: true,
    linkable: true,
  },
  /** `id` is the group (团). */
  groupbuyTeam: {
    path: 'packages/promo/groupbuy-team/index',
    params: z.strictObject({ id }),
    share: 'friend',
    miniCode: true,
    notify: true,
  },
  presaleList: {
    path: 'packages/promo/presale/index',
    params: none,
    share: 'friend',
    linkable: true,
  },
  /** `id` is the campaign. */
  presale: {
    path: 'packages/promo/presale-detail/index',
    params: z.strictObject({ id }),
    share: 'friend+timeline',
    miniCode: true,
    linkable: true,
    notify: true,
  },
  couponCenter: {
    path: 'packages/promo/coupons/index',
    params: none,
    share: 'friend',
    miniCode: true,
    linkable: true,
  },
  myCoupons: {
    path: 'packages/promo/my-coupons/index',
    params: z.strictObject({ state: z.enum(['unused', 'used', 'expired']).optional() }),
    share: 'none',
    linkable: true,
    notify: true,
  },

  // -- account ----------------------------------------------------------------
  profile: {
    path: 'packages/account/profile/index',
    params: none,
    share: 'none',
    linkable: true,
    notify: true,
  },
  settings: {
    path: 'packages/account/settings/index',
    params: none,
    share: 'none',
    linkable: true,
  },
  phone: { path: 'packages/account/phone/index', params: none, share: 'none' },
  password: { path: 'packages/account/password/index', params: none, share: 'none' },
  passwordReset: { path: 'packages/account/password-reset/index', params: none, share: 'none' },
  /** `select: '1'` opens it in pick mode from checkout. */
  addresses: {
    path: 'packages/account/addresses/index',
    params: z.strictObject({ select: z.literal('1').optional() }),
    share: 'none',
    linkable: true,
  },
  addressEdit: {
    path: 'packages/account/address-edit/index',
    params: z.strictObject({ id: optionalId }),
    share: 'none',
  },
  favorites: {
    path: 'packages/account/favorites/index',
    params: none,
    share: 'none',
    linkable: true,
  },
  history: {
    path: 'packages/account/history/index',
    params: none,
    share: 'none',
    linkable: true,
  },
  messages: {
    path: 'packages/account/messages/index',
    params: none,
    share: 'none',
    linkable: true,
    notify: true,
  },
  message: {
    path: 'packages/account/message/index',
    params: z.strictObject({ id }),
    share: 'none',
    notify: true,
  },
  invoices: {
    path: 'packages/account/invoices/index',
    params: z.strictObject({ tab: z.enum(['titles', 'records']).optional() }),
    share: 'none',
    linkable: true,
    notify: true,
  },
  invoiceTitleEdit: {
    path: 'packages/account/invoice-title-edit/index',
    params: z.strictObject({ id: optionalId }),
    share: 'none',
  },
  invoice: {
    path: 'packages/account/invoice/index',
    params: z.strictObject({ id }),
    share: 'none',
    notify: true,
  },
  invoiceApply: {
    path: 'packages/account/invoice-apply/index',
    params: z.strictObject({ orderId: id }),
    share: 'none',
  },
  cancellation: { path: 'packages/account/cancellation/index', params: none, share: 'none' },

  // -- content and page -------------------------------------------------------
  articleList: {
    path: 'packages/content/articles/index',
    params: z.strictObject({ categoryId: optionalId }),
    share: 'friend',
    linkable: true,
  },
  article: {
    path: 'packages/content/article/index',
    params: z.strictObject({ id }),
    share: 'friend+timeline',
    miniCode: true,
    linkable: true,
    notify: true,
  },
  /** Only an https URL; the client still checks it against the business domains (C12). */
  webview: {
    path: 'packages/content/webview/index',
    params: z.strictObject({ url: z.url({ protocol: /^https$/ }).max(2048) }),
    share: 'none',
  },
  /** `id` is the DIY document. */
  page: {
    path: 'packages/page/index',
    params: z.strictObject({ id }),
    share: 'friend+timeline',
    miniCode: true,
    linkable: true,
  },

  // -- appended 2026-09-23 ----------------------------------------------------
  myReviews: {
    path: 'packages/account/reviews/index',
    params: none,
    share: 'none',
    linkable: true,
  },
  myGroupbuys: {
    path: 'packages/promo/my-groupbuys/index',
    params: none,
    share: 'none',
    linkable: true,
  },
});

type Routes = typeof storefrontRoutes;

export type StorefrontRouteKey = keyof Routes;

/** The params a key takes, as parsed. */
export type StorefrontRouteParams<K extends StorefrontRouteKey = StorefrontRouteKey> = z.output<
  Routes[K]['params']
>;

/** A stored link: a key and its params. Discriminated on `route`. */
export type StorefrontRoute = {
  [K in StorefrontRouteKey]: { route: K; params: StorefrontRouteParams<K> };
}[StorefrontRouteKey];

export const storefrontRouteKeys = Object.keys(storefrontRoutes) as [
  StorefrontRouteKey,
  ...StorefrontRouteKey[],
];

export const storefrontRouteKey = z.enum(storefrontRouteKeys);

/**
 * `{ route, params }`, checked against the key's params. An unknown key does not
 * parse; the mini-program opens the home page for a key it does not know.
 */
export const storefrontRoute: z.ZodType<StorefrontRoute, StorefrontRoute> = z.discriminatedUnion(
  'route',
  storefrontRouteKeys.map((key) =>
    z.strictObject({ route: z.literal(key), params: storefrontRoutes[key].params }),
  ) as unknown as [z.ZodObject<{ route: z.ZodLiteral<StorefrontRouteKey> }>],
) as unknown as z.ZodType<StorefrontRoute, StorefrontRoute>;

/** The keys a mini-program code may open. Each takes one `id`, or nothing. */
export type StorefrontMiniCodeKey = {
  [K in StorefrontRouteKey]: Routes[K] extends { miniCode: true } ? K : never;
}[StorefrontRouteKey];

/** A key's definition, widened so its optional flags can be read on any key. */
export function storefrontRouteDef(key: StorefrontRouteKey): StorefrontRouteDef {
  return storefrontRoutes[key];
}

function definedEntries(params: object): Array<[string, string]> {
  return Object.entries(params as Record<string, string | undefined>)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The page path, no leading `/`, with the params as a URI-encoded query in key
 * order: `packages/order/detail/index?id=3001`. It is what a subscribe message's
 * `page`, a share `path` and `set_msg_jump_path` take.
 *
 * A tab page never carries a query (`switchTab` drops it): the client passes a
 * tab page's params through `pendingTabParams` (see `StorefrontRouteDef.tab`).
 *
 * Throws when the route does not parse.
 */
export function toMiniPath(r: StorefrontRoute): string {
  const route = storefrontRoute.parse(r);
  const { path, tab } = storefrontRouteDef(route.route);
  if (tab) return path;
  const query = definedEntries(route.params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return query === '' ? path : `${path}?${query}`;
}

/** WeChat's limit on a mini-program code's `scene` (C11). */
export const SCENE_MAX_BYTES = 32;
/** The characters WeChat allows in a `scene` (C11). */
const SCENE_CHARS = /^[0-9A-Za-z!#$&'()*+,/:;=?@\-._~]+$/;
/** WeChat wants at least one character; a key without params encodes as this. */
const EMPTY_SCENE = '_';

function requireMiniCode(key: string): asserts key is StorefrontMiniCodeKey {
  const known = storefrontRouteKey.safeParse(key);
  if (!known.success) throw new Error(`未知的路由 key：${key}`);
  if (!storefrontRouteDef(known.data).miniCode) throw new Error(`路由 ${key} 不能生成小程序码`);
}

/**
 * The `scene` of a mini-program code for `r`: `k=v` pairs joined by `&`, in key
 * order, or `_` for a key without params. The page itself is the code's `page`
 * (`storefrontRoutes[key].path`), so the key is not in the scene.
 *
 * Throws for a key without `miniCode`, a route that does not parse, and a scene
 * over 32 bytes or with a character WeChat refuses.
 */
export function encodeScene(r: StorefrontRoute): string {
  requireMiniCode(r.route);
  const route = storefrontRoute.parse(r);
  const pairs = definedEntries(route.params);
  const scene = pairs.length === 0 ? EMPTY_SCENE : pairs.map(([k, v]) => `${k}=${v}`).join('&');
  if (!SCENE_CHARS.test(scene)) throw new Error(`scene 含有微信不允许的字符：${scene}`);
  if (scene.length > SCENE_MAX_BYTES)
    throw new Error(`scene 超过 ${SCENE_MAX_BYTES} 字节：${scene}`);
  return scene;
}

/**
 * The params of `key` from a code's `scene`. `options.scene` arrives
 * URI-encoded; either form is accepted (`%` is not a scene character, so a `%`
 * means it is still encoded).
 *
 * Throws for a key without `miniCode` and for a scene that does not give valid
 * params for the key.
 */
export function decodeScene<K extends StorefrontMiniCodeKey>(
  key: K,
  scene: string,
): StorefrontRouteParams<K>;
export function decodeScene(key: StorefrontRouteKey, scene: string): StorefrontRouteParams;
export function decodeScene(key: StorefrontRouteKey, scene: string): StorefrontRouteParams {
  requireMiniCode(key);
  const raw = scene.includes('%') ? decodeURIComponent(scene) : scene;
  const params = new Map<string, string>();
  if (raw !== EMPTY_SCENE && raw !== '') {
    for (const pair of raw.split('&')) {
      const at = pair.indexOf('=');
      if (at <= 0) throw new Error(`scene 格式不正确：${scene}`);
      const name = pair.slice(0, at);
      if (params.has(name)) throw new Error(`scene 参数重复：${name}`);
      params.set(name, pair.slice(at + 1));
    }
  }
  return storefrontRoute.parse({ route: key, params: Object.fromEntries(params) }).params;
}
