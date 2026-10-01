#!/usr/bin/env node
/**
 * Size and safety gate for the WeChat build (`dist/weapp`). Run after `build:weapp`:
 *
 *   node scripts/size-report.mjs [--dist dist/weapp] [--main-kb 1536] [--total-kb 8192]
 *                                [--subpackage-kb 1024] [--json]
 *
 * Budgets also come from MINI_BUDGET_MAIN_KB / MINI_BUDGET_TOTAL_KB / MINI_BUDGET_SUBPACKAGE_KB.
 * WeChat's own hard limits are 2 MB for the main package and for each sub-package, and 20 MB in
 * total; the defaults leave headroom (docs/mini/spikes/S1-taro.md).
 *
 * `build:weapp` runs it after every production weapp build, so a build over budget fails.
 *
 * It fails (exit 1) when:
 *
 * - the main package, a sub-package or the total is over budget;
 * - the output holds a source map (`*.map` or a `sourceMappingURL` comment), the dev-only
 *   `subpackages/` tree (the UI gallery; `TARO_APP_DEMO=1` accepts it for a phone-only build),
 *   a test fixture or test tooling, or an admin route (`/admin-api`, `*.admin*` route ids);
 * - a module in the main package is reached only from sub-package pages (Taro moves those into
 *   the sub-packages; one left in the main package costs every cold start);
 * - any script uses a browser global the WeChat runtime lacks (`AbortController`, `TextEncoder`…)
 *   that the build does not provide;
 * - any stylesheet has a universal selector (`*`; WeChat's WXSS compiler rejects it);
 * - any script contains `new Function(` or `eval(` (WeChat's JSCore on iOS refuses them, and
 *   the review team flags dynamic code);
 * - any script does not parse as ES2018, the target in babel.config.js (the WeChat runtime
 *   does not transpile node_modules for us; `es6: false` in project.config.json);
 * - a module that creates a zustand store is copied into several sub-packages (`sub-common`), so
 *   each has its own state;
 * - app.json lists a page or sub-package that is not in the output;
 * - any file carries a 32-hex-digit token (the shape of an AppSecret or a payment key; those live
 *   only in the server's config) that is not the name of a chunk in the output, or the output holds a miniprogram-ci upload key
 *   (`private.*.key`);
 * - any file carries the e2e suite's H5 emulation (`src/platform/h5-mp-emulation.tsx`: its
 *   `/__e2e/` endpoints or its storage key) or the H5 preview, or the module list includes
 *   `src/platform/runtime.h5.tsx` or either implementation (docs/mini/spikes/S4-e2e.md);
 * - the build's module list (`.bundle-stats/weapp.json`, written by config/bundle-stats.ts) is
 *   missing or older than the build, or shows more than one copy of react, react-dom,
 *   react-reconciler, @tarojs/runtime or TanStack Query, or any zod at all.
 *
 * On success it writes `dist/weapp.gate.json`, the fingerprint of the files it passed;
 * `preview.mjs` and `upload.mjs` refuse a build that does not match it (gate-stamp.mjs).
 *
 * Package sizes count every file WeChat uploads: everything except the developer-tool project
 * files. The report ends with the main package's breakdown by owner (raw module bytes, before
 * minification): what to look at first when the main package grows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'acorn';
import { clearStamp, NOT_UPLOADED, writeStamp } from './gate-stamp.mjs';

const appRoot = path.resolve(import.meta.dirname, '..');
const KB = 1024;

const { values: args } = parseArgs({
  options: {
    dist: { type: 'string', default: 'dist/weapp' },
    'main-kb': { type: 'string' },
    'total-kb': { type: 'string' },
    'subpackage-kb': { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});

function budget(flag, envName, fallback) {
  const raw = args[flag] ?? process.env[envName];
  if (raw === undefined || raw === '') return fallback * KB;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag}: not a size in KB: ${raw}`);
  return value * KB;
}

const budgets = {
  main: budget('main-kb', 'MINI_BUDGET_MAIN_KB', 1536),
  total: budget('total-kb', 'MINI_BUDGET_TOTAL_KB', 8192),
  subpackage: budget('subpackage-kb', 'MINI_BUDGET_SUBPACKAGE_KB', 1024),
};

const dist = path.resolve(appRoot, args.dist);
const failures = [];

if (!fs.existsSync(path.join(dist, 'app.json'))) {
  console.error(
    `size-report: ${path.relative(appRoot, dist)}/app.json not found; run build:weapp first.`,
  );
  process.exit(1);
}

// A run that fails, or stops half-way, leaves no record that the gate passed (gate-stamp.mjs).
clearStamp(dist);

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true }).flatMap((entry) => {
    if (!entry.isFile()) return [];
    const rel = path
      .relative(dist, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join('/');
    if (NOT_UPLOADED.has(rel)) return [];
    return [{ rel, size: fs.statSync(path.join(dist, rel)).size }];
  });
}

const appJson = JSON.parse(fs.readFileSync(path.join(dist, 'app.json'), 'utf8'));
const subPackages = (appJson.subPackages ?? appJson.subpackages ?? []).map((pkg) => ({
  name: pkg.name ?? pkg.root,
  root: pkg.root.replace(/\/+$/, ''),
  pages: pkg.pages ?? [],
}));

const files = listFiles(dist);
const packages = new Map([['main', { name: 'main', files: 0, bytes: 0 }]]);
for (const pkg of subPackages) packages.set(pkg.root, { name: pkg.name, files: 0, bytes: 0 });

function packageOf(rel) {
  const pkg = subPackages.find((candidate) => rel.startsWith(`${candidate.root}/`));
  return pkg ? pkg.root : 'main';
}

for (const file of files) {
  const entry = packages.get(packageOf(file.rel));
  entry.files += 1;
  entry.bytes += file.size;
}
const total = files.reduce((sum, file) => sum + file.size, 0);

// --- budgets --------------------------------------------------------------------------------
const main = packages.get('main');
if (main.bytes > budgets.main)
  failures.push(`main package ${kb(main.bytes)} > budget ${kb(budgets.main)}`);
for (const [root, entry] of packages) {
  if (root !== 'main' && entry.bytes > budgets.subpackage) {
    failures.push(
      `sub-package ${entry.name} ${kb(entry.bytes)} > budget ${kb(budgets.subpackage)}`,
    );
  }
}
if (total > budgets.total) failures.push(`total ${kb(total)} > budget ${kb(budgets.total)}`);

// --- nothing that is not the product -------------------------------------------------------
// The dev-only tree (`src/subpackages/`: the UI kit gallery, spike S3's block fixture) is left
// out of a production weapp build by app.config.ts; `TARO_APP_DEMO=1` builds it in on purpose.
const DEV_ONLY_ROOT = /^subpackages\//;
const demoAccepted = process.env.TARO_APP_DEMO === '1';
for (const pkg of subPackages.filter((candidate) => DEV_ONLY_ROOT.test(candidate.root))) {
  if (demoAccepted) console.warn(`size-report: dev-only ${pkg.root} accepted (TARO_APP_DEMO=1)`);
  else failures.push(`app.json lists the dev-only ${pkg.root} (set TARO_APP_DEMO=1 to accept)`);
}
for (const file of files) {
  if (file.rel.endsWith('.map')) failures.push(`${file.rel}: a source map in the package`);
}
// Admin routes: the api-client's catalogue is the storefront's only; an admin path or route id
// in the package means a contract barrel or the admin client leaked in.
const ADMIN_ROUTE = /\/admin-api\b|\b[a-z][A-Za-z]*\.admin[A-Z]\w*/;
for (const file of files.filter((candidate) => /\.(js|json|wxml|wxss)$/.test(candidate.rel))) {
  const source = fs.readFileSync(path.join(dist, file.rel), 'utf8');
  if (/[#@]\s*sourceMappingURL=/.test(source))
    failures.push(`${file.rel}: a sourceMappingURL comment`);
  const admin = ADMIN_ROUTE.exec(source);
  if (admin) failures.push(`${file.rel}: an admin route ("${admin[0]}")`);
}

// --- app.json points at real pages ----------------------------------------------------------
const pageFiles = [
  ...(appJson.pages ?? []),
  ...subPackages.flatMap((pkg) => pkg.pages.map((page) => `${pkg.root}/${page}`)),
];
const present = new Set(files.map((file) => file.rel));
for (const page of pageFiles) {
  for (const ext of ['js', 'json', 'wxml']) {
    if (!present.has(`${page}.${ext}`))
      failures.push(`app.json lists ${page} but ${page}.${ext} is missing`);
  }
}

// --- no test-only code ---------------------------------------------------------------------
// The H5 builds pick their platform in src/platform/runtime.h5.tsx; the WeChat build must not
// contain it or anything behind it, above all the e2e emulation, which settles payments
// through a test harness. Markers are strings the emulation cannot work without.
const TEST_ONLY_MARKERS = ['/__e2e/', '__shop_mp_emulation__', 'h5-mp-emulation', 'h5-preview'];
const TEST_ONLY_MODULES = /\/src\/platform\/(runtime\.h5|h5-mp-emulation|h5-preview)\.tsx?$/;
for (const file of files) {
  if (!/\.(js|json|wxml|wxs)$/.test(file.rel)) continue;
  const source = fs.readFileSync(path.join(dist, file.rel), 'utf8');
  for (const marker of TEST_ONLY_MARKERS) {
    if (source.includes(marker)) failures.push(`${file.rel}: contains test-only "${marker}"`);
  }
}

// --- no secrets -----------------------------------------------------------------------------
// Everything in the package is readable by anyone who opens the mini-program. The `mini` guard
// checks the source for the same shapes; this checks what the build inlined (env vars included).
const SECRET_LIKE = /(?<![0-9A-Za-z])[0-9a-f]{32}(?![0-9A-Za-z])/g;
// Taro names a sub-package's shared chunks by a hash of their modules
// (`packages/order/sub-common/<32 hex>.js|.wxss`), and every page of the sub-package requires or
// imports them by that name. A token that is the name of a file in the output is that, not a key.
const CHUNK_NAMES = new Set(
  fs
    .readdirSync(dist, { recursive: true })
    .map((name) => path.basename(String(name)).replace(/\.(js|wxss)$/, ''))
    .filter((name) => /^[0-9a-f]{32}$/.test(name)),
);
for (const entry of fs.readdirSync(dist, { withFileTypes: true, recursive: true })) {
  if (!entry.isFile()) continue;
  const rel = path
    .relative(dist, path.join(entry.parentPath, entry.name))
    .split(path.sep)
    .join('/');
  if (/^private\..+\.key$/.test(entry.name)) {
    failures.push(`${rel}: a miniprogram-ci upload key in the build output`);
    continue;
  }
  if (!/\.(js|json|wxml|wxs|wxss)$/.test(rel) || rel.endsWith('.map')) continue;
  const source = fs.readFileSync(path.join(dist, rel), 'utf8');
  for (const match of source.matchAll(SECRET_LIKE)) {
    if (CHUNK_NAMES.has(match[0])) continue;
    failures.push(
      `${rel}: a 32-hex-digit token (${match[0].slice(0, 4)}…) at offset ${match.index}, the shape of an AppSecret`,
    );
  }
}

// --- dynamic code and syntax level ----------------------------------------------------------
const DYNAMIC_CODE = [
  { label: 'new Function(', pattern: /\bnew\s+Function\s*\(/g },
  { label: 'eval(', pattern: /(?<![\w$.])eval\s*\(/g },
];
for (const file of files.filter((candidate) => candidate.rel.endsWith('.js'))) {
  const source = fs.readFileSync(path.join(dist, file.rel), 'utf8');
  for (const { label, pattern } of DYNAMIC_CODE) {
    for (const match of source.matchAll(pattern)) {
      const at = match.index ?? 0;
      const context = source.slice(Math.max(0, at - 60), at + 40).replace(/\s+/g, ' ');
      failures.push(`${file.rel}: ${label} at offset ${at}: …${context}…`);
    }
  }
  try {
    parse(source, { ecmaVersion: 2018, sourceType: 'script' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const at = typeof error?.pos === 'number' ? error.pos : 0;
    const context = source.slice(Math.max(0, at - 60), at + 40).replace(/\s+/g, ' ');
    failures.push(
      `${file.rel}: not ES2018 (${message}): …${context}… (add the dependency to compile.include)`,
    );
  }
}

// --- browser globals the WeChat runtime lacks ----------------------------------------------
// A phone's mini-program runtime has none of these; WeChat DevTools and the H5 e2e build do, so
// only a phone would show the ReferenceError. AbortController / AbortSignal are provided by the
// build (config/index.ts, src/platform/abort-controller.ts); any bare one left is a crash.
// A name after `.`, a quote or a word character, or before `:`, is a property, not the global.
// Not listed: the names Taro's build swaps for its own partial versions (`URLSearchParams`,
// `URL`, `window`, `document`, `navigator`, `location`, `requestAnimationFrame`…), which leave
// no bare name here, and `fetch`, `setImmediate`, `MessageChannel` and `globalThis`, which the
// libraries mention behind a `typeof` check. The source is linted for all of them
// (packages/config/eslint/weapp.js, `no-restricted-globals`).
const MISSING_GLOBALS = new RegExp(
  `(?<![\\w$.'"\`])(${[
    'AbortController',
    'AbortSignal',
    'TextEncoder',
    'TextDecoder',
    'structuredClone',
    'DOMException',
    'localStorage',
    'sessionStorage',
    'btoa',
    'atob',
    'Headers',
    'FormData',
    'Blob',
    'FileReader',
    'XMLHttpRequest',
    'WebSocket',
    'IntersectionObserver',
    'ResizeObserver',
    'matchMedia',
    'getComputedStyle',
    'queueMicrotask',
    'crypto',
    'Buffer',
  ].join('|')})\\b(?!\\s*:)`,
  'g',
);
for (const file of files.filter((candidate) => candidate.rel.endsWith('.js'))) {
  const source = fs.readFileSync(path.join(dist, file.rel), 'utf8');
  for (const match of source.matchAll(MISSING_GLOBALS)) {
    const at = match.index ?? 0;
    const context = source.slice(Math.max(0, at - 60), at + 40).replace(/\s+/g, ' ');
    failures.push(`${file.rel}: ${match[1]}, which the WeChat runtime lacks: …${context}…`);
  }
}

// --- template attributes the runtime knows ------------------------------------------------
// config/a11y-plugin.js adds aria-* to the templates and, through config/a11y-runtime.js, to the
// runtime's component table. Taro numbers attributes on each side separately, so a template with
// them and a runtime without them shifts every number: blank images, buttons that act disabled.
const baseWxml = path.join(dist, 'base.wxml');
if (fs.existsSync(baseWxml) && fs.readFileSync(baseWxml, 'utf8').includes('aria-hidden=')) {
  const registered = files
    .filter((candidate) => candidate.rel.endsWith('.js'))
    .some((file) => fs.readFileSync(path.join(dist, file.rel), 'utf8').includes('"aria-hidden"'));
  if (!registered)
    failures.push(
      'base.wxml binds aria-* but no script registers them with the runtime (config/a11y-runtime.js)',
    );
}

// --- WXSS the WeChat compiler accepts ------------------------------------------------------
// WeChat's WXSS compiler rejects the universal selector (`*`, e.g. `> *`) and the upload fails
// with -80056; the H5 emulation and the simulator accept it, so nothing earlier catches it.
// Only selectors are checked: the text before each `{` (a `*` in a declaration is `calc()`).
const UNIVERSAL_SELECTOR = /(^|[\s,>+~(])\*(?=$|[\s,>+~.:#[{)])/;
for (const file of files.filter((candidate) => candidate.rel.endsWith('.wxss'))) {
  const source = fs
    .readFileSync(path.join(dist, file.rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of source.matchAll(/([^{};]*)\{/g)) {
    const selector = match[1].trim();
    if (UNIVERSAL_SELECTOR.test(selector))
      failures.push(`${file.rel}: universal selector "${selector}" (WXSS rejects \`*\`)`);
  }
}

// --- one copy of the runtime ---------------------------------------------------------------
const SINGLE_COPY = [
  'react',
  'react-dom',
  'react-reconciler',
  '@tarojs/runtime',
  '@tanstack/react-query',
  '@tanstack/query-core',
];
const statsFile = path.join(appRoot, '.bundle-stats', 'weapp.json');
let copies;
/** Raw (pre-minification) module bytes per npm package, to explain where the size goes. */
let heaviest;
/** The same for the main package only, by npm package or source directory. */
let mainBreakdown;

// Test code and tooling (`src/test/` fixtures and fakes, `*.test.*`, the storefront-blocks
// fixtures, @shop/testing, the test runners): the package is the product only.
const TEST_CODE =
  /\/src\/test\/|\.(test|spec)\.[cm]?[jt]sx?$|fixtures?\.[cm]?[jt]sx?$|\/packages\/testing\/|\/node_modules\/(@testing-library|happy-dom|vitest|@vitest|msw)\//;
const DEV_ONLY_MODULES = /\/apps\/mini\/src\/subpackages\//;

/** `react`, `@tarojs/runtime`, `packages/storefront-blocks/src/blocks`, `apps/mini/src/ui`… */
function ownerOf(normalized) {
  const npm = /.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(normalized);
  if (npm) return npm[1];
  // A directory under a workspace package's `src` (`src/ui`), or a file at its top.
  const source = /\/((?:apps|packages)\/[^/]+\/src\/[^/]+)/.exec(normalized);
  return source ? source[1] : '(other)';
}
// The stats are written after the build emits, so stats older than app.json are from an
// earlier build.
const statsFresh =
  fs.existsSync(statsFile) &&
  fs.statSync(statsFile).mtimeMs >= fs.statSync(path.join(dist, 'app.json')).mtimeMs;
if (statsFresh) {
  const { modules } = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  const dirsByPackage = new Map();
  const bytesByPackage = new Map();
  const mainBytesByOwner = new Map();
  const onlySubPackages = [];
  for (const module of modules) {
    const normalized = module.path.split(path.sep).join('/');
    const shown = path.relative(appRoot, module.path);
    if (TEST_ONLY_MODULES.test(normalized))
      failures.push(`test-only module in the WeChat build: ${shown}`);
    if (TEST_CODE.test(normalized)) failures.push(`test code in the WeChat build: ${shown}`);
    if (DEV_ONLY_MODULES.test(normalized) && !demoAccepted)
      failures.push(`dev-only module in the WeChat build: ${shown}`);
    // Taro emits a chunk several sub-packages share as `sub-common/<hash>` and copies it into
    // each of them (the root copy is not in the output).
    const inMain = module.files.some(
      (file) => packageOf(file) === 'main' && !file.startsWith('sub-common/'),
    );
    // A copy per sub-package is a store per sub-package: state one sets, another never sees
    // (确认订单 in order handing an address to 编辑地址 in account). Hand such state over
    // through storage or keep its module in the main package.
    if (
      !inMain &&
      module.files.some((file) => file.startsWith('sub-common/')) &&
      !normalized.includes('/node_modules/') &&
      /\.[cm]?[jt]sx?$/.test(normalized) &&
      fs.existsSync(module.path) &&
      /from\s+['"]zustand['"]/.test(fs.readFileSync(module.path, 'utf8'))
    ) {
      failures.push(
        `store copied into sub-packages ${(module.usedBy ?? []).join(', ')}: ${shown} (each gets its own copy of the state)`,
      );
    }
    if (inMain) {
      const owner = ownerOf(normalized);
      mainBytesByOwner.set(owner, (mainBytesByOwner.get(owner) ?? 0) + module.size);
      // `usedBy` is empty only if the walk in config/bundle-stats.ts missed a module; that is a
      // bug there, and it would hide this check, so it fails too.
      if (!module.usedBy?.includes('main')) onlySubPackages.push({ shown, module });
    }
    const match = /^(.*\/node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(normalized);
    const owner = match ? match[2] : normalized.includes('/packages/') ? '(workspace)' : '(app)';
    bytesByPackage.set(owner, (bytesByPackage.get(owner) ?? 0) + module.size);
    if (!match) continue;
    const [, dir, name] = match;
    if (!dirsByPackage.has(name)) dirsByPackage.set(name, new Set());
    dirsByPackage.get(name).add(dir);
  }
  copies = Object.fromEntries(
    SINGLE_COPY.map((name) => [name, dirsByPackage.get(name)?.size ?? 0]),
  );
  for (const name of SINGLE_COPY) {
    if (copies[name] > 1)
      failures.push(
        `${copies[name]} copies of ${name}: ${[...dirsByPackage.get(name)].join(', ')}`,
      );
  }
  heaviest = [...bytesByPackage].sort((a, b) => b[1] - a[1]).slice(0, 10);
  mainBreakdown = [...mainBytesByOwner].sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const { shown, module } of onlySubPackages) {
    const users = module.usedBy?.length ? module.usedBy.join(', ') : 'no entry';
    failures.push(`${shown} is in the main package but only ${users} use it`);
  }
  if (dirsByPackage.has('zod'))
    failures.push('zod is in the bundle (contracts must be imported as types)');
} else {
  failures.push(`${path.relative(appRoot, statsFile)} is missing or older than the build; rebuild`);
}

// --- report ---------------------------------------------------------------------------------
const report = {
  dist: path.relative(appRoot, dist),
  budgets,
  packages: [...packages.values()],
  total,
  copies: copies ?? null,
  heaviest: heaviest ?? null,
  mainBreakdown: mainBreakdown ?? null,
  failures,
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const rows = [...packages.values()].map((entry) => [
    entry.name,
    String(entry.files),
    kb(entry.bytes),
  ]);
  rows.push(['total', String(files.length), kb(total)]);
  const width = Math.max(...rows.map((row) => row[0].length));
  console.log(
    `size-report ${report.dist}  (budgets: main ${kb(budgets.main)}, sub-package ${kb(budgets.subpackage)}, total ${kb(budgets.total)})`,
  );
  for (const [name, count, size] of rows)
    console.log(`  ${name.padEnd(width)}  ${count.padStart(4)} files  ${size.padStart(10)}`);
  if (copies) {
    console.log(
      `  copies: ${Object.entries(copies)
        .map(([name, n]) => `${name}×${n}`)
        .join(', ')}`,
    );
    const list = heaviest.map(([name, bytes]) => `${name} ${kb(bytes)}`).join(', ');
    console.log(`  heaviest (raw module bytes): ${list}`);
    console.log('  main package by owner (raw module bytes):');
    for (const [owner, bytes] of mainBreakdown)
      console.log(`    ${kb(bytes).padStart(10)}  ${owner}`);
  } else {
    console.log('  copies: not checked');
  }
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  console.log(failures.length ? `size-report: ${failures.length} failure(s)` : 'size-report: ok');
}

if (failures.length === 0) writeStamp(dist);
process.exit(failures.length ? 1 : 0);

function kb(bytes) {
  return `${(bytes / KB).toFixed(1)} KB`;
}
