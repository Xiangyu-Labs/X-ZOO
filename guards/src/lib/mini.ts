/**
 * Reading the Taro mini-program (`apps/mini`) for the `mini` check.
 *
 * Everything here is pure, over source text or an already-evaluated app
 * manifest, so it is unit-tested against small strings (`mini.test.ts`). The
 * check itself (`checks/mini.ts`) does the file system.
 */
import { lineOf, stripComments } from './files';

/**
 * The `@tarojs/taro` exports any component may import: lifecycle hooks and the
 * router hook. Mirrors `TARO_HOOKS` in `apps/mini/eslint.config.mjs`; the lint
 * rule sees imports only, the guard also sees `Taro.x` and `wx.x`.
 */
export const TARO_HOOKS: ReadonlySet<string> = new Set([
  'useDidHide',
  'useDidShow',
  'useLaunch',
  'useLoad',
  'usePageScroll',
  'usePullDownRefresh',
  'useReachBottom',
  'useReady',
  'useResize',
  'useRouter',
  'useShareAppMessage',
  'useShareTimeline',
  'useTabItemTap',
  'useUnload',
]);

/**
 * Open types of `<Button>` that hand the page something private, and the event
 * props that receive it (docs/mini/wechat-compliance.md C04, C05). Only
 * `src/platform/` renders them; a page gets a component from the platform.
 */
export const PRIVATE_OPEN_TYPES: ReadonlySet<string> = new Set([
  'getPhoneNumber',
  'getRealtimePhoneNumber',
  'chooseAvatar',
  'agreePrivacyAuthorization',
]);
const PRIVATE_EVENT_PROPS = [
  'onGetPhoneNumber',
  'onGetRealtimePhoneNumber',
  'onChooseAvatar',
  'onAgreePrivacyAuthorization',
];

/**
 * The APIs `requiredPrivateInfos` governs: WeChat refuses them at run time
 * unless `app.json` declares them (C04, "只管地理位置类接口和 chooseAddress").
 */
export const PRIVATE_INFO_APIS: ReadonlySet<string> = new Set([
  'chooseAddress',
  'getFuzzyLocation',
  'getLocation',
  'onLocationChange',
  'startLocationUpdate',
  'startLocationUpdateBackground',
  'chooseLocation',
  'choosePoi',
]);

/**
 * The APIs the privacy guide must declare, as the shop uses them (C04's table):
 * called only from `src/platform/`, and each listed in `platform/privacy.ts`'s
 * `PRIVACY_APIS` once that file exists.
 */
export const PRIVACY_GUARDED_APIS: ReadonlySet<string> = new Set([
  'chooseAddress',
  'chooseInvoiceTitle',
  'chooseMedia',
  'chooseImage',
  'saveImageToPhotosAlbum',
  'setClipboardData',
  'getClipboardData',
  'getPhoneNumber',
  'chooseAvatar',
]);

/** Retired by WeChat for this purpose, anywhere in the app, platform included (C05). */
export const BANNED_APIS: ReadonlySet<string> = new Set(['getUserProfile', 'getUserInfo']);

/** A use of a mini-program API, however it was spelt. */
export interface ApiUse {
  name: string;
  /** `Taro.x`, `wx.x`, `import { x } from '@tarojs/taro'`, `import Taro`, `openType="x"` … */
  via: string;
  line: number;
}

const MEMBER = /(?<![\w$.])(Taro|wx)\s*\.\s*([A-Za-z_$][\w$]*)/g;
const TARO_IMPORT = /import\s+([^'";]*?)\s+from\s*['"]@tarojs\/taro['"]/g;

/**
 * Every `Taro.x` / `wx.x` member reference and every value imported from
 * `@tarojs/taro`, in code (comments removed, so a note about `wx.login` is not
 * a call). The default import itself is reported as `Taro` with via `import
 * Taro`, because holding it is how a page would call anything.
 */
export function taroApiUses(source: string): ApiUse[] {
  const code = stripComments(source);
  const out: ApiUse[] = [];
  for (const match of code.matchAll(MEMBER)) {
    out.push({
      name: match[2] ?? '',
      via: `${match[1] ?? ''}.${match[2] ?? ''}`,
      line: lineOf(code, match.index),
    });
  }
  for (const match of code.matchAll(TARO_IMPORT)) {
    const clause = (match[1] ?? '').replace(/^type\s+/, '');
    if (/^type\s/.test(match[1] ?? '')) continue;
    const line = lineOf(code, match.index);
    const braces = /\{([^}]*)\}/.exec(clause);
    const outside = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/,/g, ' ')
      .trim();
    if (outside) {
      out.push({ name: 'Taro', via: `import ${outside.replace(/\s+/g, ' ')}`, line });
    }
    for (const part of (braces?.[1] ?? '').split(',')) {
      const spec = part.trim();
      if (!spec || spec.startsWith('type ')) continue;
      const imported = spec.split(/\s+as\s+/)[0]?.trim() ?? '';
      if (imported) out.push({ name: imported, via: `import { ${imported} }`, line });
    }
  }
  return out;
}

/** `<Button openType="getPhoneNumber">`, `open-type='chooseAvatar'`, `onGetPhoneNumber={…}`. */
export function privateOpenTypes(source: string): ApiUse[] {
  const code = stripComments(source);
  const out: ApiUse[] = [];
  for (const match of code.matchAll(/(?:openType|open-type)\s*=\s*\{?\s*(['"`])([\w|]+)\1/g)) {
    for (const type of (match[2] ?? '').split('|')) {
      if (PRIVATE_OPEN_TYPES.has(type)) {
        out.push({
          name: type,
          via: `openType="${match[2] ?? ''}"`,
          line: lineOf(code, match.index),
        });
      }
    }
  }
  for (const prop of PRIVATE_EVENT_PROPS) {
    for (const match of code.matchAll(new RegExp(`\\b${prop}\\s*=`, 'g'))) {
      out.push({ name: prop, via: prop, line: lineOf(code, match.index) });
    }
  }
  for (const match of code.matchAll(/\btype\s*=\s*\{?\s*(['"`])nickname\1/g)) {
    out.push({ name: 'nickname', via: 'type="nickname"', line: lineOf(code, match.index) });
  }
  return out;
}

/** Every module specifier (import, export-from, require, dynamic import, scss @use/@import). */
export function specifiersOf(source: string): Array<{ specifier: string; line: number }> {
  const code = stripComments(source);
  const out: Array<{ specifier: string; line: number }> = [];
  const patterns = [
    /(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?[\w*${}\s,]*?\s*from\s*(['"])([^'"]+)\1/g,
    /(?:^|[\n;])\s*import\s*(['"])([^'"]+)\1/g,
    /\b(?:require|import)\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    /@(?:use|import|forward)\s+(['"])([^'"]+)\1/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      out.push({ specifier: match[2] ?? '', line: lineOf(code, match.index) });
    }
  }
  return out;
}

/** `@nutui/…`, or a path into a NutUI package (`~@nutui/…`, `node_modules/@nutui/…`). */
export function isNutUi(specifier: string): boolean {
  return /(^|[/~])@nutui\//.test(specifier);
}

/**
 * String literals that are mini-program page paths or storefront API paths:
 * `'/pages/product/index?id=1'`, `` `packages/order/cashier/index?orderId=${id}` ``,
 * `'/api/v1/…'`. Returned without the query string.
 */
export function urlLiterals(source: string): Array<{ url: string; line: number }> {
  const code = stripComments(source);
  const out: Array<{ url: string; line: number }> = [];
  const literal = /(['"`])(\/?(?:pages|packages|subpackages)\/[\w\-/]+|\/api\/v1\/[\w\-/:${}.]*)/g;
  for (const match of code.matchAll(literal)) {
    out.push({ url: match[2] ?? '', line: lineOf(code, match.index) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// the manifest
// ---------------------------------------------------------------------------

/** The part of `app.config.ts` (Taro's `app.json`) the check reads. */
export interface AppManifest {
  pages?: unknown;
  subPackages?: unknown;
  subpackages?: unknown;
  tabBar?: { list?: unknown } | undefined;
  requiredPrivateInfos?: unknown;
}

export interface RegisteredPage {
  /** `pages/home/index`, `packages/order/checkout/index` — how WeChat names it. */
  path: string;
  /** The sub-package root, or null for the main package. */
  root: string | null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Every page the manifest registers, main package first, sub-package pages joined to their root. */
export function registeredPages(manifest: AppManifest): RegisteredPage[] {
  const out: RegisteredPage[] = strings(manifest.pages).map((path) => ({ path, root: null }));
  const groups = manifest.subPackages ?? manifest.subpackages;
  if (Array.isArray(groups)) {
    for (const group of groups as Array<{ root?: unknown; pages?: unknown }>) {
      const root = typeof group.root === 'string' ? group.root.replace(/\/+$/, '') : '';
      for (const page of strings(group.pages)) out.push({ path: `${root}/${page}`, root });
    }
  }
  return out;
}

/** `tabBar.list[].pagePath`, in order. */
export function tabBarPaths(manifest: AppManifest): string[] {
  const list = manifest.tabBar?.list;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (item as { pagePath?: unknown }).pagePath)
    .filter((p): p is string => typeof p === 'string');
}

export function requiredPrivateInfos(manifest: AppManifest): string[] {
  return strings(manifest.requiredPrivateInfos);
}

/**
 * A page source file, relative to `src/`: `<dir>/<name>.config.ts` next to a
 * `<dir>/<name>.{tsx,ts,jsx,js}` under `pages/`, `packages/` or `subpackages/`.
 * Taro gives every page a config file (its `navigationBarTitleText` at the
 * least), which is what tells a page from a component living beside it.
 * Returns the page path (`packages/order/checkout/index`) or null.
 */
export function pageOfConfigFile(relative: string): string | null {
  const match = /^((?:pages|packages|subpackages)\/.+)\.config\.[jt]s$/.exec(relative);
  return match?.[1] ?? null;
}

export const PAGE_SOURCE_SUFFIXES = ['.tsx', '.ts', '.jsx', '.js'];

/** The `export const <name> = …` initializer, up to its closing bracket, or null. */
export function exportedInitializer(source: string, name: string): string | null {
  const start = new RegExp(`export\\s+const\\s+${name}\\b[^=]*=\\s*`).exec(source);
  if (!start) return null;
  let at = start.index + start[0].length;
  const open = source[at];
  const close = open === '[' ? ']' : open === '{' ? '}' : null;
  if (!close || !open) return null;
  let depth = 0;
  for (; at < source.length; at += 1) {
    if (source[at] === open) depth += 1;
    else if (source[at] === close) {
      depth -= 1;
      if (depth === 0) return source.slice(start.index + start[0].length, at + 1);
    }
  }
  return null;
}
