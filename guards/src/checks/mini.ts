import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { storefrontRoutes } from '@shop/contracts/system/storefront-routes';
import { defineCheck, fail, note, result, type Finding } from '../framework';
import { isScript, walk, type SourceFile } from '../lib/files';
import {
  BANNED_APIS,
  PAGE_SOURCE_SUFFIXES,
  PRIVACY_GUARDED_APIS,
  PRIVATE_INFO_APIS,
  TARO_HOOKS,
  exportedInitializer,
  isNutUi,
  pageOfConfigFile,
  privateOpenTypes,
  registeredPages,
  requiredPrivateInfos,
  specifiersOf,
  tabBarPaths,
  taroApiUses,
  urlLiterals,
  type AppManifest,
  type RegisteredPage,
} from '../lib/mini';
import { apiClientSrc, miniApp, rel, repoRoot, storefrontBlocksSrc } from '../lib/paths';
import { retiredInUrl } from './retired';

/**
 * The Taro mini-program (`apps/mini`), read against the route catalogue and the
 * WeChat rules in `docs/mini/wechat-compliance.md`.
 *
 * Eight rules, each reported with its tag so a finding says which one broke:
 *
 * - **[pages]** The app is whole. Every page `app.config.ts` registers (main
 *   package and sub-packages) has its source file, and every page file under
 *   `src/pages|packages|subpackages` (a `<name>.config.ts` beside its
 *   `<name>.tsx`) is registered. tabBar pages are in the main package (C13).
 *   Dev-only pages live in the `subpackages/demo` sub-package and nothing
 *   outside it imports from it.
 * - **[routes]** The route catalogue (`@shop/contracts/system/storefront-routes`)
 *   and the pages agree: every catalogue path is a registered page, every
 *   registered page outside the demo sub-package has a catalogue key, and the
 *   catalogue's `tab: true` keys are exactly the tabBar, key for key
 *   (`platform/tab-pages.ts`) and path for path (`tabBar.list`).
 * - **[platform]** Only `src/platform/` touches WeChat: no `Taro.x` / `wx.x`
 *   and no `@tarojs/taro` import but the lifecycle hooks, and no private
 *   `openType` button, anywhere else in `src`, `@shop/api-client` or
 *   `@shop/storefront-blocks`. Pages navigate, pay, sign in and copy through
 *   the platform. `getUserProfile` / `getUserInfo` appear nowhere (C05).
 * - **[nutui]** NutUI is not used: no `@nutui/*` import, script or
 *   stylesheet, anywhere in the app (`src/ui/` included) or the shared
 *   packages. The kit is our own; NutUI was removed as a dependency (L2).
 * - **[privacy]** Every `requiredPrivateInfos` API the app calls is declared,
 *   and only the ones this shop uses may be (C04: `chooseAddress`). Once
 *   `platform/privacy.ts` exists, every privacy-guarded API the platform calls
 *   is listed in its `PRIVACY_APIS`.
 * - **[retired]** No retired feature (`retired`'s word list) in a page path, a
 *   catalogue path, or a page/API URL literal in the app or the blocks.
 * - **[config]** What is committed is safe to commit: `urlCheck` stays on, the
 *   AppID is the shop's own (`wx4f4b772125e155ed`, public) or the tourist
 *   placeholder and nothing else, and no committed env file sets a plain
 *   `http://` API origin (C03).
 * - **[credentials]** No WeChat secret sits in the app: no `private.*.key`
 *   (miniprogram-ci's upload key) under `apps/mini` or tracked anywhere in the
 *   repository, and no 32-hex-digit AppSecret-like token in any file under
 *   `apps/mini`. The AppSecret lives only in the server's config; the upload
 *   key outside the repository (docs/mini/device-check.md). The built
 *   `dist/weapp` gets the same token scan in `scripts/size-report.mjs`.
 *
 * Tests (`*.test.*`, `src/test/`) are exempt from [platform], [nutui] and
 * [privacy]: the fake Taro runtime is how they stand in for WeChat.
 */

export const MINI_RULES = [
  'pages',
  'routes',
  'platform',
  'nutui',
  'privacy',
  'retired',
  'config',
  'credentials',
] as const;
export type MiniRule = (typeof MINI_RULES)[number];

/** The sub-package that holds dev-only pages (the UI kit, the S3 block fixture). */
const DEMO_ROOT = 'subpackages/demo';

/**
 * The AppIDs a committed file may carry: the shop's approved mini-program (a
 * public identifier, shown on every share card) and Taro's placeholder. Any
 * other AppID is someone's own and belongs in `.env.*.local`.
 */
const COMMITTED_APP_IDS: ReadonlySet<string> = new Set(['wx4f4b772125e155ed', 'touristappid']);

/** miniprogram-ci's upload key, as WeChat names it on download. */
const UPLOAD_KEY = /^private\..+\.key$/;

/**
 * A 32-hex-digit token on its own: the shape of an AppSecret (and of an
 * mchKey / APIv3 key). Lower-case only, as WeChat issues them; bounded by
 * non-alphanumerics so a longer hash or an identifier does not match.
 */
const SECRET_LIKE = /(?<![0-9A-Za-z])[0-9a-f]{32}(?![0-9A-Za-z])/g;

/** Directories under `apps/mini` the [credentials] scan skips: tools' output, not files anyone writes. */
const SECRET_SCAN_SKIP = new Set([
  'node_modules',
  'dist',
  '.swc',
  '.bundle-stats',
  '.turbo',
  'coverage',
]);

/** What this shop may declare in `requiredPrivateInfos` (C04: "此外不声明任何项"). */
const SHOP_PRIVATE_INFOS: ReadonlySet<string> = new Set(['chooseAddress']);

/**
 * Catalogue keys whose page is not built yet. Exactly compared: a key whose
 * page is now registered, or that left the catalogue, fails until it is
 * deleted — so the list only shrinks, page by page, as streams A and B land.
 */
const UNBUILT_ROUTES: readonly string[] = [];

/**
 * Registered pages (outside the demo sub-package) with no catalogue key, each
 * with the reason. Exactly compared, like UNBUILT_ROUTES.
 */
const UNCATALOGUED_PAGES: Readonly<Record<string, string>> = {};

export interface MiniRoots {
  /** `apps/mini`, or a scratch copy of it (the mutation tests). */
  app: string;
  /** Shared packages scanned for [platform] / [nutui] / [retired]; the live ones by default. */
  packages?: readonly string[];
}

interface CatalogueRoute {
  key: string;
  path: string;
  tab: boolean;
}

function catalogue(): CatalogueRoute[] {
  return Object.entries(storefrontRoutes as Record<string, { path: string; tab?: true }>).map(
    ([key, def]) => ({ key, path: def.path, tab: def.tab === true }),
  );
}

const tagged = (rule: MiniRule, where: string, message: string): Finding =>
  fail(where, `[${rule}] ${message}`);

/**
 * `app.config.ts` evaluated the way Taro's config compiler does: an ES module
 * whose default export is `defineAppConfig({...})`, a global macro.
 */
async function loadModule(file: string): Promise<Record<string, unknown>> {
  const globals = globalThis as Record<string, unknown>;
  globals['defineAppConfig'] ??= (config: unknown) => config;
  globals['definePageConfig'] ??= (config: unknown) => config;
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}

const isTest = (relative: string): boolean =>
  relative.startsWith('test/') || /\.(test|spec)\.[cm]?[jt]sx?$/.test(relative);

export interface MiniReport {
  findings: Finding[];
  summary: string;
}

export async function checkMini(roots: MiniRoots): Promise<MiniReport> {
  const findings: Finding[] = [];
  const appRoot = roots.app;
  const srcRoot = path.join(appRoot, 'src');
  const shown = (relative: string): string => `apps/mini/${relative}`;
  const packages = roots.packages ?? [apiClientSrc, storefrontBlocksSrc];

  // --- the manifest --------------------------------------------------------
  const configFile = path.join(srcRoot, 'app.config.ts');
  let manifest: AppManifest = {};
  try {
    manifest = ((await loadModule(configFile))['default'] ?? {}) as AppManifest;
  } catch (error) {
    findings.push(
      tagged('pages', shown('src/app.config.ts'), `could not be evaluated: ${String(error)}`),
    );
  }
  const configWhere = shown('src/app.config.ts');
  const pages = registeredPages(manifest);
  const registered = new Set(pages.map((page) => page.path));
  const tabBar = tabBarPaths(manifest);

  const sources = walk(srcRoot, (name) => isScript(name) || /\.(s?css|less)$/.test(name));
  const scripts = sources.filter((file) => isScript(file.file) && !file.relative.endsWith('.d.ts'));

  checkPages(findings, { pages, registered, tabBar, sources, srcRoot, configWhere, shown });
  const routeCount = checkRoutes(findings, { pages, tabBar, appRoot, configWhere, shown });
  checkPlatform(findings, scripts, shown, packages);
  checkNutUi(findings, sources, shown, packages);
  const declared = checkPrivacy(findings, { manifest, scripts, srcRoot, configWhere, shown });
  checkRetired(findings, { pages, scripts, shown, packages, configWhere });
  checkConfig(findings, appRoot, shown);
  checkCredentials(findings, appRoot, shown, appRoot === miniApp);

  return {
    findings,
    summary: `${pages.length} pages (${tabBar.length} tabs); ${routeCount} catalogue routes (${UNBUILT_ROUTES.length} unbuilt); ${scripts.length} source files; requiredPrivateInfos [${declared.join(', ')}]`,
  };
}

// ---------------------------------------------------------------------------
// [pages]
// ---------------------------------------------------------------------------

function checkPages(
  findings: Finding[],
  input: {
    pages: RegisteredPage[];
    registered: Set<string>;
    tabBar: string[];
    sources: SourceFile[];
    srcRoot: string;
    configWhere: string;
    shown: (relative: string) => string;
  },
): void {
  const { pages, registered, tabBar, sources, srcRoot, configWhere, shown } = input;
  if (pages.length === 0) findings.push(tagged('pages', configWhere, 'registers no pages'));

  const seen = new Set<string>();
  for (const page of pages) {
    if (seen.has(page.path))
      findings.push(tagged('pages', configWhere, `registers ${page.path} twice`));
    seen.add(page.path);
    const hasSource = PAGE_SOURCE_SUFFIXES.some((suffix) =>
      fs.existsSync(path.join(srcRoot, `${page.path}${suffix}`)),
    );
    if (!hasSource) {
      findings.push(
        tagged('pages', configWhere, `registers ${page.path}, which has no src/${page.path}.tsx`),
      );
    }
    const demoPath = page.path
      .split('/')
      .some((segment) => /^(demo|dev|playground)$/.test(segment));
    if (page.root === DEMO_ROOT) continue;
    if (page.path.startsWith(`${DEMO_ROOT}/`) || demoPath) {
      findings.push(
        tagged(
          'pages',
          configWhere,
          `registers the dev-only page ${page.path} outside the ${DEMO_ROOT} sub-package`,
        ),
      );
    }
  }

  // Every page file is registered: a page nobody can open is dead code in the package.
  for (const file of sources) {
    const page = pageOfConfigFile(file.relative);
    if (page === null) continue;
    if (!registered.has(page)) {
      findings.push(
        tagged(
          'pages',
          shown(`src/${file.relative}`),
          `is the page ${page}, which app.config.ts does not register`,
        ),
      );
    }
  }

  // tabBar pages must be in the main package (WeChat refuses a sub-package tab, C13).
  const main = new Set(pages.filter((page) => page.root === null).map((page) => page.path));
  for (const tab of tabBar) {
    if (!main.has(tab)) {
      findings.push(
        tagged('pages', configWhere, `tabBar lists ${tab}, which is not a main-package page`),
      );
    }
  }

  // Demo code stays in the demo sub-package.
  for (const file of sources) {
    if (file.relative.startsWith(`${DEMO_ROOT}/`)) continue;
    for (const { specifier, line } of specifiersOf(file.text)) {
      if (specifier.includes(DEMO_ROOT)) {
        findings.push(
          tagged(
            'pages',
            `${shown(`src/${file.relative}`)}:${line}`,
            `imports ${specifier}: the dev-only sub-package is not a library`,
          ),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// [routes]
// ---------------------------------------------------------------------------

function checkRoutes(
  findings: Finding[],
  input: {
    pages: RegisteredPage[];
    tabBar: string[];
    appRoot: string;
    configWhere: string;
    shown: (relative: string) => string;
  },
): number {
  const { pages, tabBar, appRoot, configWhere, shown } = input;
  const routes = catalogue();
  const where = 'packages/contracts/src/system/storefront-routes.ts';
  const registered = new Set(pages.map((page) => page.path));
  const byPath = new Map(routes.map((route) => [route.path, route]));
  const keys = new Set(routes.map((route) => route.key));
  const unbuilt = new Set(UNBUILT_ROUTES);

  for (const route of routes) {
    const built = registered.has(route.path);
    if (unbuilt.has(route.key)) {
      if (built) {
        findings.push(
          tagged(
            'routes',
            'UNBUILT_ROUTES',
            `${route.key} (${route.path}) is registered now — delete the entry`,
          ),
        );
      }
      continue;
    }
    if (!built) {
      findings.push(
        tagged(
          'routes',
          where,
          `${route.key} → ${route.path}, which app.config.ts does not register`,
        ),
      );
    }
  }
  for (const key of unbuilt) {
    if (!keys.has(key)) {
      findings.push(
        tagged('routes', 'UNBUILT_ROUTES', `${key} is not a catalogue key — delete the entry`),
      );
    }
  }

  for (const page of pages) {
    if (page.root === DEMO_ROOT) continue;
    const excused = UNCATALOGUED_PAGES[page.path];
    if (byPath.has(page.path)) {
      if (excused) {
        findings.push(
          tagged(
            'routes',
            'UNCATALOGUED_PAGES',
            `${page.path} has a catalogue key now — delete the entry`,
          ),
        );
      }
      continue;
    }
    if (!excused) {
      findings.push(
        tagged(
          'routes',
          configWhere,
          `registers ${page.path}, which no storefront route key names`,
        ),
      );
    }
  }
  for (const [page, why] of Object.entries(UNCATALOGUED_PAGES)) {
    if (!registered.has(page)) {
      findings.push(
        tagged(
          'routes',
          'UNCATALOGUED_PAGES',
          `${page} is not registered any more — delete the entry (${why})`,
        ),
      );
    }
  }

  // The tab bar, three ways: the catalogue's `tab: true` keys, platform/tab-pages.ts and tabBar.list.
  const catalogueTabs = routes.filter((route) => route.tab);
  for (const route of catalogueTabs) {
    if (unbuilt.has(route.key)) continue;
    if (!tabBar.includes(route.path)) {
      findings.push(
        tagged(
          'routes',
          configWhere,
          `tabBar does not list ${route.path}, the catalogue's tab ${route.key}`,
        ),
      );
    }
  }
  for (const tab of tabBar) {
    const route = byPath.get(tab);
    if (route && !route.tab) {
      findings.push(
        tagged('routes', where, `${route.key} (${tab}) is on the tabBar but not \`tab: true\``),
      );
    }
  }
  const tabPagesFile = path.join(appRoot, 'src/platform/tab-pages.ts');
  if (fs.existsSync(tabPagesFile)) {
    const source = fs.readFileSync(tabPagesFile, 'utf8');
    const initializer = exportedInitializer(source, 'TAB_PAGES') ?? '';
    const tabKeys = [...initializer.matchAll(/\bkey\s*:\s*(['"])([^'"]+)\1/g)].map(
      (m) => m[2] ?? '',
    );
    const expected = catalogueTabs.map((route) => route.key);
    const same =
      tabKeys.length === expected.length && tabKeys.every((key) => expected.includes(key));
    if (!same) {
      findings.push(
        tagged(
          'routes',
          shown('src/platform/tab-pages.ts'),
          `TAB_PAGES keys [${tabKeys.join(', ')}] are not the catalogue's tab keys [${expected.join(', ')}]`,
        ),
      );
    }
  }
  return routes.length;
}

// ---------------------------------------------------------------------------
// [platform]
// ---------------------------------------------------------------------------

function checkPlatform(
  findings: Finding[],
  scripts: SourceFile[],
  shown: (relative: string) => string,
  packages: readonly string[],
): void {
  const scan = (file: SourceFile, where: string, inPlatform: boolean): void => {
    for (const use of taroApiUses(file.text)) {
      const at = `${where}:${use.line}`;
      if (BANNED_APIS.has(use.name)) {
        findings.push(
          tagged('platform', at, `${use.via}: WeChat no longer hands out profiles this way (C05)`),
        );
        continue;
      }
      if (inPlatform) continue;
      if (use.via.startsWith('import {') && TARO_HOOKS.has(use.name)) continue;
      findings.push(
        tagged(
          'platform',
          at,
          `${use.via} outside src/platform/ — go through @/platform (navigation, login, payment, clipboard …)`,
        ),
      );
    }
    if (inPlatform) return;
    for (const use of privateOpenTypes(file.text)) {
      findings.push(
        tagged(
          'platform',
          `${where}:${use.line}`,
          `${use.via} outside src/platform/ — render the platform's component`,
        ),
      );
    }
  };

  for (const file of scripts) {
    if (isTest(file.relative)) continue;
    scan(file, shown(`src/${file.relative}`), file.relative.startsWith('platform/'));
  }
  for (const root of packages) {
    for (const file of walk(root, isScript)) {
      if (isTest(file.relative) || file.relative.startsWith('test-support/')) continue;
      scan(file, rel(file.file), false);
    }
  }
}

// ---------------------------------------------------------------------------
// [nutui]
// ---------------------------------------------------------------------------

function checkNutUi(
  findings: Finding[],
  sources: SourceFile[],
  shown: (relative: string) => string,
  packages: readonly string[],
): void {
  for (const file of sources) {
    if (isTest(file.relative)) continue;
    for (const { specifier, line } of specifiersOf(file.text)) {
      if (isNutUi(specifier)) {
        findings.push(
          tagged(
            'nutui',
            `${shown(`src/${file.relative}`)}:${line}`,
            `imports ${specifier}; NutUI is not used — use the kit (src/ui)`,
          ),
        );
      }
    }
  }
  for (const root of packages) {
    for (const file of walk(root, (name) => isScript(name) || /\.s?css$/.test(name))) {
      for (const { specifier, line } of specifiersOf(file.text)) {
        if (isNutUi(specifier)) {
          findings.push(
            tagged('nutui', `${rel(file.file)}:${line}`, `imports ${specifier}; NutUI is not used`),
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// [privacy]
// ---------------------------------------------------------------------------

function checkPrivacy(
  findings: Finding[],
  input: {
    manifest: AppManifest;
    scripts: SourceFile[];
    srcRoot: string;
    configWhere: string;
    shown: (relative: string) => string;
  },
): string[] {
  const { manifest, scripts, srcRoot, configWhere, shown } = input;
  const declared = requiredPrivateInfos(manifest);
  const used = new Map<string, string>();
  const guarded = new Map<string, string>();
  for (const file of scripts) {
    if (isTest(file.relative)) continue;
    const uses = [...taroApiUses(file.text), ...privateOpenTypes(file.text)];
    for (const use of uses) {
      const at = `${shown(`src/${file.relative}`)}:${use.line}`;
      if (PRIVATE_INFO_APIS.has(use.name) && !used.has(use.name)) used.set(use.name, at);
      if (PRIVACY_GUARDED_APIS.has(use.name) && !guarded.has(use.name)) guarded.set(use.name, at);
    }
  }

  for (const [api, at] of used) {
    if (!declared.includes(api)) {
      findings.push(
        tagged(
          'privacy',
          at,
          `calls ${api}, which app.config.ts does not declare in requiredPrivateInfos (C04)`,
        ),
      );
    }
  }
  for (const api of declared) {
    if (!SHOP_PRIVATE_INFOS.has(api)) {
      findings.push(
        tagged(
          'privacy',
          configWhere,
          `declares ${api} in requiredPrivateInfos; this shop declares only ${[...SHOP_PRIVATE_INFOS].join(', ')} (C04)`,
        ),
      );
    } else if (!used.has(api)) {
      findings.push(note(configWhere, `[privacy] declares ${api}, which nothing calls yet`));
    }
  }

  // The guide's own list, once stream A writes it (C04: platform/privacy.ts, PRIVACY_APIS).
  const privacyFile = path.join(srcRoot, 'platform/privacy.ts');
  if (fs.existsSync(privacyFile)) {
    const listed = exportedInitializer(fs.readFileSync(privacyFile, 'utf8'), 'PRIVACY_APIS');
    if (listed === null) {
      findings.push(
        tagged('privacy', shown('src/platform/privacy.ts'), 'does not export PRIVACY_APIS'),
      );
    } else {
      for (const [api, at] of guarded) {
        if (!new RegExp(`\\b${api}\\b`).test(listed)) {
          findings.push(
            tagged(
              'privacy',
              at,
              `uses ${api}, which PRIVACY_APIS (platform/privacy.ts) does not list`,
            ),
          );
        }
      }
    }
  }
  return declared;
}

// ---------------------------------------------------------------------------
// [retired]
// ---------------------------------------------------------------------------

function checkRetired(
  findings: Finding[],
  input: {
    pages: RegisteredPage[];
    scripts: SourceFile[];
    shown: (relative: string) => string;
    packages: readonly string[];
    configWhere: string;
  },
): void {
  const { pages, scripts, shown, packages, configWhere } = input;
  const flag = (where: string, url: string): void => {
    const word = retiredInUrl(url);
    if (word)
      findings.push(tagged('retired', where, `${url} is a URL for the retired ${word.feature}`));
  };
  for (const page of pages) flag(configWhere, page.path);
  for (const route of catalogue()) flag(`storefront route ${route.key}`, route.path);
  for (const file of scripts) {
    for (const { url, line } of urlLiterals(file.text))
      flag(`${shown(`src/${file.relative}`)}:${line}`, url);
  }
  for (const root of packages) {
    for (const file of walk(root, isScript)) {
      if (file.relative.endsWith('.gen.ts')) continue;
      for (const { url, line } of urlLiterals(file.text)) flag(`${rel(file.file)}:${line}`, url);
    }
  }
}

// ---------------------------------------------------------------------------
// [config]
// ---------------------------------------------------------------------------

function checkConfig(
  findings: Finding[],
  appRoot: string,
  shown: (relative: string) => string,
): void {
  const projectFile = path.join(appRoot, 'project.config.json');
  if (fs.existsSync(projectFile)) {
    const project = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as {
      appid?: unknown;
      setting?: { urlCheck?: unknown };
    };
    if (project.setting?.urlCheck !== true) {
      findings.push(
        tagged(
          'config',
          shown('project.config.json'),
          'setting.urlCheck must stay true; turn it off locally in DevTools (C03)',
        ),
      );
    }
    if (typeof project.appid !== 'string' || !COMMITTED_APP_IDS.has(project.appid)) {
      findings.push(
        tagged(
          'config',
          shown('project.config.json'),
          `appid is ${String(project.appid)}; commit only the shop's wx4f4b772125e155ed or touristappid, anything else goes in .env.*.local`,
        ),
      );
    }
  } else {
    findings.push(tagged('config', shown('project.config.json'), 'is missing'));
  }

  // Committed env files only: `.env.*.local` is gitignored and is where a developer's AppID lives.
  for (const name of fs.readdirSync(appRoot).sort()) {
    if (!/^\.env(\..+)?$/.test(name) || name.endsWith('.local')) continue;
    const text = fs.readFileSync(path.join(appRoot, name), 'utf8');
    for (const [index, raw] of text.split('\n').entries()) {
      const line = raw.trim();
      const match = /^(?:export\s+)?([A-Z0-9_]+)\s*=\s*["']?([^"'#\s]*)/.exec(line);
      if (!match || line.startsWith('#')) continue;
      const [, key, value = ''] = match;
      const where = `${shown(name)}:${index + 1}`;
      if (key === 'TARO_APP_ID' && !COMMITTED_APP_IDS.has(value)) {
        findings.push(
          tagged(
            'config',
            where,
            `commits the AppID ${value}, which is not the shop's; put it in ${name}.local (gitignored)`,
          ),
        );
      }
      if (key === 'TARO_APP_API_ORIGIN' && /^http:\/\//.test(value)) {
        findings.push(
          tagged(
            'config',
            where,
            `commits a plain-http API origin ${value}; the mini-program only talks https (C03)`,
          ),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// [credentials]
// ---------------------------------------------------------------------------

/** Every file under `root`, skipping tools' output; names only, read on demand. */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SECRET_SCAN_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out.sort();
}

function checkCredentials(
  findings: Finding[],
  appRoot: string,
  shown: (relative: string) => string,
  live: boolean,
): void {
  for (const file of filesUnder(appRoot)) {
    const relative = path.relative(appRoot, file).split(path.sep).join('/');
    if (UPLOAD_KEY.test(path.basename(file))) {
      findings.push(
        tagged(
          'credentials',
          shown(relative),
          'is a miniprogram-ci upload key; keep it outside the repository and point WX_MINI_UPLOAD_KEY_PATH at it',
        ),
      );
      continue;
    }
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) continue; // binary: images, fonts
    const text = buffer.toString('utf8');
    for (const match of text.matchAll(SECRET_LIKE)) {
      const line = text.slice(0, match.index).split('\n').length;
      findings.push(
        tagged(
          'credentials',
          `${shown(relative)}:${line}`,
          `holds a 32-hex-digit token (${match[0].slice(0, 4)}…), the shape of an AppSecret; secrets live only in the server's config`,
        ),
      );
    }
  }

  // Tracked anywhere, not only under apps/mini. Only the live tree is a git checkout.
  if (!live) return;
  let tracked: string[] = [];
  try {
    tracked = execFileSync('git', ['ls-files', '-z', '--', ':(glob)**/private.*.key'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    findings.push(
      note('.', '[credentials] git ls-files failed; tracked upload keys were not checked'),
    );
  }
  for (const file of tracked) {
    findings.push(
      tagged(
        'credentials',
        file,
        'is a tracked miniprogram-ci upload key; remove it from git and rotate it',
      ),
    );
  }
}

export const miniCheck = defineCheck(
  'mini',
  'the mini-program: pages, route catalogue, platform seam, no NutUI, privacy, retired URLs, committed config, credentials',
  async () => {
    const { findings, summary } = await checkMini({ app: miniApp });
    return result('mini', 'mini-program', summary, findings);
  },
);
