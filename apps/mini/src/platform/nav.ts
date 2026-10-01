import { useState } from 'react';
import Taro, { useRouter } from '@tarojs/taro';
import { create } from 'zustand';
import {
  storefrontRoutes,
  type StorefrontRoute,
  type StorefrontRouteKey,
} from '@shop/api-client/routes';
import { parseQuery } from '@/lib/query';
import { fromPairs } from '@/lib/defined';

/**
 * Navigation by route key (docs/mini/pages.md §3). Pages, DIY links, messages and shares name a
 * page by `{ route, params }` from the catalogue (`@shop/api-client/routes`), never by path, so
 * a page can move without breaking a link that is already saved or printed.
 *
 * - An unknown key (a link made for a newer client) opens the home page instead of failing.
 * - A tab page cannot take a query (`switchTab` drops it): its params wait in
 *   `pendingTabParams` and the page takes them in `useDidShow` (`useTabParams`).
 * - `navigateTo` past WeChat's 10-page stack fails, so the tenth page replaces the top instead.
 */

type Routes = typeof storefrontRoutes;

/** The param names a key takes, all optional strings: a page checks what it needs. */
export type RouteParamsOf<K extends StorefrontRouteKey> = {
  [P in Routes[K]['params'][number]]?: string;
};

const HOME = storefrontRoutes.home.path;
const MAX_STACK = 10;

function entryOf(key: string) {
  return Object.prototype.hasOwnProperty.call(storefrontRoutes, key)
    ? storefrontRoutes[key as StorefrontRouteKey]
    : null;
}

/** Declared params with a value, in key order (the order `toMiniPath` uses). */
function definedParams(key: StorefrontRouteKey, params: object): Array<[string, string]> {
  const allowed: readonly string[] = storefrontRoutes[key].params;
  return Object.entries(params as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .filter(([name]) => allowed.includes(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The page path with its query, leading `/`: `/packages/order/detail/index?id=3001`. A tab page
 * never carries a query. An unknown key is the home page. Matches the contracts' `toMiniPath`
 * (plus the slash `navigateTo` wants).
 */
export function toPath(route: StorefrontRoute | { route: string; params?: object }): string {
  const entry = entryOf(route.route);
  if (!entry) return `/${HOME}`;
  if (entry.tab) return `/${entry.path}`;
  const query = definedParams(route.route as StorefrontRouteKey, route.params ?? {})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return query === '' ? `/${entry.path}` : `/${entry.path}?${query}`;
}

interface PendingTabParams {
  byKey: Partial<Record<StorefrontRouteKey, Record<string, string>>>;
}

/** Params for a tab page, waiting for its next `useDidShow`. */
export const usePendingTabParams = create<PendingTabParams>()(() => ({ byKey: {} }));

/** Takes (and clears) the params waiting for a tab page. */
export function takeTabParams<K extends StorefrontRouteKey>(key: K): RouteParamsOf<K> {
  const params = usePendingTabParams.getState().byKey[key] ?? {};
  usePendingTabParams.setState((state) => {
    const byKey = { ...state.byKey };
    delete byKey[key];
    return { byKey };
  });
  return params as RouteParamsOf<K>;
}

export interface NavigateOptions {
  /** Replace the current page (`redirectTo`) instead of pushing one. */
  replace?: boolean;
}

function stackPages(): readonly StackPage[] {
  return typeof Taro.getCurrentPages === 'function' ? Taro.getCurrentPages() : [];
}

function stackDepth(): number {
  return stackPages().length;
}

/**
 * How long after a page opened the same page is not opened again, while the shopper is still on
 * it. A second tap on the old page can arrive just after the push has landed.
 */
const REPEAT_MS = 500;

/** The last page push or replace: its target, and once landed, when and at what stack depth. */
interface LastOpen {
  key: string;
  run: Promise<void>;
  landed: { at: number; depth: number } | null;
}

let lastOpen: LastOpen | null = null;

/**
 * Opens a page (`navigateTo` / `redirectTo`) unless this very open is already under way or has
 * just landed: a double tap on 结算, 立即购买 or a card must not stack the page twice. Narrow on
 * purpose: only the same method and the same URL (params included); the second call shares the
 * first one's outcome while it runs, and is dropped for `REPEAT_MS` after it landed only while
 * the stack is as that open left it (going back, or anything else, lets it through). A failed
 * open is forgotten at once, so a retry goes through.
 */
function openOnce(key: string, open: () => Promise<unknown>): Promise<void> {
  const last = lastOpen;
  if (last && last.key === key) {
    if (!last.landed) return last.run;
    if (Date.now() - last.landed.at < REPEAT_MS && stackDepth() === last.landed.depth) {
      return Promise.resolve();
    }
  }
  const entry: LastOpen = { key, run: Promise.resolve(), landed: null };
  entry.run = open().then(
    () => {
      entry.landed = { at: Date.now(), depth: stackDepth() };
    },
    (error: unknown) => {
      if (lastOpen === entry) lastOpen = null;
      throw error;
    },
  );
  lastOpen = entry;
  return entry.run;
}

/** Forget the last open (tests: each starts with nothing under way). */
export function resetOpenGuard(): void {
  lastOpen = null;
}

/**
 * Opens a page by route. Never throws for an unknown key: that opens the home page. The same
 * page asked for twice in a row (a double tap) opens once (`openOnce`); tab switches are not
 * guarded, a second `switchTab` to the same tab being harmless.
 *
 * A push to the very page under this one (same route, same params) goes back to it instead:
 * 订单详情 → 拼团进度 →「查看订单」, 商品 → 拼团 →「单独购买」. Pushing would stack a second copy,
 * and Back would show the page twice; this happened page by page until it moved here.
 */
export async function navigate(
  route: StorefrontRoute | { route: string; params?: object },
  { replace = false }: NavigateOptions = {},
): Promise<void> {
  const entry = entryOf(route.route);
  if (!entry || entry.tab) {
    const key = (entry ? route.route : 'home') as StorefrontRouteKey;
    const params = entry ? fromPairs(definedParams(key, route.params ?? {})) : {};
    usePendingTabParams.setState((state) => ({ byKey: { ...state.byKey, [key]: params } }));
    await Taro.switchTab({ url: `/${storefrontRoutes[key].path}` });
    return;
  }
  const url = toPath(route);
  if (!replace && loginReturn(route, stackPages()) === 'back') {
    await openOnce(`navigateBack ${url}`, () => Taro.navigateBack({ delta: 1 }));
    return;
  }
  if (replace || stackDepth() >= MAX_STACK) {
    await openOnce(`redirectTo ${url}`, () => Taro.redirectTo({ url }));
  } else {
    await openOnce(`navigateTo ${url}`, () => Taro.navigateTo({ url }));
  }
}

/** Back one page, or home when this is the first page (opened from a share or a code). */
export async function goBack(): Promise<void> {
  if (stackDepth() > 1) await Taro.navigateBack({ delta: 1 });
  else await navigate({ route: 'home', params: {} });
}

function decodeValue(value: string): string {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The params a page was opened with (`useLoad(options)` / `useRouter().params`), for its key:
 *
 * - opened from a mini-program code: `options.scene` (URI-encoded `k=v&k=v`, or `_` for none;
 *   C11) is decoded;
 * - otherwise the declared params are taken from the query and URI-decoded;
 * - a tab page also takes what `navigate` left for it.
 *
 * Unknown names are dropped. Values are not validated: the page checks what it needs.
 */
export function readRouteParams<K extends StorefrontRouteKey>(
  key: K,
  options: Record<string, string | undefined> | undefined,
): RouteParamsOf<K> {
  const allowed: readonly string[] = storefrontRoutes[key].params;
  const out: Record<string, string> = {};
  const scene = options?.['scene'];
  if (scene !== undefined && scene !== '') {
    const raw = decodeValue(scene);
    if (raw !== '_') {
      for (const pair of raw.split('&')) {
        const at = pair.indexOf('=');
        if (at <= 0) continue;
        const name = pair.slice(0, at);
        if (allowed.includes(name)) out[name] = pair.slice(at + 1);
      }
    }
  } else {
    for (const name of allowed) {
      const value = options?.[name];
      if (typeof value === 'string' && value !== '') out[name] = decodeValue(value);
    }
  }
  if (storefrontRoutes[key].tab) Object.assign(out, takeTabParams(key));
  return out as RouteParamsOf<K>;
}

/**
 * `readRouteParams` for the current page (`useRouter().params`). Tab pages use
 * `useTabPage(key)` instead, which also picks up params left by a later `navigate`.
 */
export function useRouteParams<K extends StorefrontRouteKey>(key: K): RouteParamsOf<K> {
  const { params } = useRouter();
  const [value] = useState(() => readRouteParams(key, params));
  return value;
}

/**
 * The decor editor's draft preview token (F2 opens `packages/page/index?id=&previewToken=`).
 * Deliberately not a catalogue param: a preview link is never shared, saved or linked from DIY.
 * `null` when absent or not token-shaped.
 */
export function usePreviewToken(): string | null {
  const { params } = useRouter();
  const [value] = useState(() => {
    const raw = params.previewToken;
    return typeof raw === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(raw) ? raw : null;
  });
  return value;
}

/**
 * A `login.redirect` value back to a route (pages.md §3.2): JSON of a catalogue route, never a
 * path (no open redirect), never `login` itself. Anything else is `null`.
 */
export function parseLoginRedirect(value: string | undefined): StorefrontRoute | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeValue(value));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { route, params } = parsed as { route?: unknown; params?: unknown };
  if (typeof route !== 'string' || route === 'login' || !entryOf(route)) return null;
  const key = route as StorefrontRouteKey;
  const clean = fromPairs(
    definedParams(key, typeof params === 'object' && params !== null ? params : {}),
  );
  return { route: key, params: clean } as StorefrontRoute;
}

/**
 * A page on the stack as `getCurrentPages()` returns it. WeChat gives `route` (no leading
 * slash, no query) and `options`; Taro's H5 router gives `route` and `path` with a leading
 * slash, the query only in `path`; Taro's runtime adds `$taroParams` on both.
 */
export interface StackPage {
  route?: string | undefined;
  path?: string | undefined;
  options?: Record<string, string | undefined> | undefined;
  $taroParams?: Record<string, string | undefined> | undefined;
}

/**
 * How the login page leaves once signed in (pages.md §3.2). `back` when the page under it is
 * the redirect target itself, same route and same params (商品详情 → 登录 → 商品详情):
 * `navigateBack` returns to it, where `redirectTo` would stack a second copy of it. `replace`
 * otherwise (the target is another page, or login was the first page): the login page is
 * replaced by the target, or a tab is switched to.
 */
export function loginReturn(
  target: StorefrontRoute | { route: string; params?: object },
  stack: readonly StackPage[],
): 'back' | 'replace' {
  const entry = entryOf(target.route);
  const below = routeOfPage(stack.length >= 2 ? stack[stack.length - 2] : undefined);
  if (!entry || !below || below.route !== target.route) return 'replace';
  // A tab takes its params through `navigate` (pending tab params), never through going back.
  if (entry.tab) {
    const key = target.route as StorefrontRouteKey;
    return definedParams(key, target.params ?? {}).length === 0 ? 'back' : 'replace';
  }
  return toPath(below) === toPath(target) ? 'back' : 'replace';
}

/** The route and params of a page on the stack; `null` for login or a path not in the catalogue. */
function routeOfPage(page: StackPage | undefined): StorefrontRoute | null {
  if (!page) return null;
  const [path = ''] = (page.route ?? page.path ?? '').replace(/^\//, '').split('?');
  const key = routeKeyOfPath(path);
  if (!key || key === 'login') return null;
  // A tab's params wait in `pendingTabParams` for the tab itself; reading them here would take them.
  if (storefrontRoutes[key].tab) return { route: key, params: {} } as StorefrontRoute;
  const options = {
    ...parseQuery(page.path?.split('?')[1] ?? ''),
    ...page.$taroParams,
    ...page.options,
  };
  return { route: key, params: readRouteParams(key, options) } as StorefrontRoute;
}

/** Whether the shopper is on the login page now (a second one must not open over it). */
export function onLoginPage(): boolean {
  const stack = stackPages();
  const page = stack[stack.length - 1];
  if (!page) return false;
  const [path = ''] = (page.route ?? page.path ?? '').replace(/^\//, '').split('?');
  return routeKeyOfPath(path) === 'login';
}

/** The page the shopper is on, as a route (the login page's `redirect`); `null` on login. */
export function currentRoute(): StorefrontRoute | null {
  const stack = stackPages();
  return routeOfPage(stack[stack.length - 1]);
}

/**
 * Leaves this page for `target` without stacking a second copy of it: back to the nearest page
 * under this one that is `target` (same route, same params; `loginReturn` decides), however deep,
 * else `target` in place of this page. 登录 once signed in; 收银台 and 支付结果's 查看订单,
 * which were usually opened from that very 订单详情 — sometimes by way of 拼团进度 (订单详情 →
 * 拼团进度 → 收银台 → 支付结果), whose page between is left with the payment.
 */
export async function leaveFor(
  target: StorefrontRoute | { route: string; params?: object },
): Promise<void> {
  const stack = stackPages();
  for (let delta = 1; delta < stack.length; delta += 1) {
    // The stack as it would be with `delta - 1` pages gone: is the page under its top `target`?
    if (loginReturn(target, stack.slice(0, stack.length - delta + 1)) === 'back') {
      await Taro.navigateBack({ delta });
      return;
    }
  }
  await navigate(target, { replace: true });
}

/** Leaves the login page for `target` once signed in, as `loginReturn` decides. */
export async function returnFromLogin(
  target: StorefrontRoute | { route: string; params?: object },
): Promise<void> {
  await leaveFor(target);
}

/** The route of a page path (`pages/product/index`), for launch options; `null` if unknown. */
export function routeKeyOfPath(path: string): StorefrontRouteKey | null {
  const clean = path.replace(/^\//, '').split('?')[0] ?? '';
  for (const [key, entry] of Object.entries(storefrontRoutes)) {
    if (entry.path === clean) return key as StorefrontRouteKey;
  }
  return null;
}
