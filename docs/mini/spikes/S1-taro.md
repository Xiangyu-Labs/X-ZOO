# Spike S1: Taro 4.2 + React 18 for the WeChat mini-program

Branch `storefront/mini-S1-taro`, app `apps/mini` (`@shop/mini`). Date 2026-09-23.

**Verdict: GO**, with the conditions at the end. Taro 4.2.1 on webpack 5 builds a WeChat package
and an H5 site from one React 18 tree inside the pnpm workspace. That tree includes TanStack
Query, zustand, NutUI and a runtime import from `@shop/contracts`. The WeChat output has one
React, no zod, no `eval`/`new Function`, and is ES2018. Every check passes. The workarounds are
small and local, and each has a guard that fails if it stops working. Two things are not proven
here and need a device: runtime tab-bar icons, and real-device performance.

## Versions

| Piece                              | Version                  | Note                                                              |
| ---------------------------------- | ------------------------ | ----------------------------------------------------------------- |
| `@tarojs/*` (cli, runtime, runner) | 4.2.1, exact             | `webpack5` runner, webpack 5.91.0 (Taro's pin)                    |
| React / react-reconciler           | 18.3.1 / 0.29.0          | Taro 4.2's reconciler is React 18 only                            |
| `@types/react`, `@types/react-dom` | 19.3.0                   | shared with apps/web on purpose, see workaround 10                |
| `@nutui/nutui-react-taro`          | 3.0.19, exact            | 3.0.20 cannot be installed (workaround 12)                        |
| `@tanstack/react-query`            | 5.103.2                  | same version as apps/web                                          |
| zustand                            | 5.0.15                   |                                                                   |
| babel-preset-taro                  | 4.2.1                    | targets pinned to iOS 12 / Chrome 70                              |
| TypeScript                         | 7.0.2 (`tsc`)            | shared `tsconfig.base.json`, strict, `exactOptionalPropertyTypes` |
| Vitest / happy-dom / RTL           | 5.0.1 / 20.14.5 / 16.3.3 | React 18 renderer                                                 |
| Node / pnpm                        | 24.20 / 12.5.1           |                                                                   |

## What is in `apps/mini`

```
config/            Taro config (index/dev/prod) + two webpack plugins (global object, bundle stats)
scripts/           size-report.mjs: size budgets and safety scan of dist/weapp
src/app.config.ts  4 native tabs (首页 分类 购物车 我的), sub-package `demo`, lazyCodeLoading,
                   __usePrivacyCheck__ + requiredPrivateInfos ['chooseAddress']
src/platform/      the only place that calls Taro.* APIs (lint-enforced): lifecycle, network,
                   tab bar, navigation
src/data/          QueryClient + focus/online adapters, useRefetchOnShow, zustand shell store,
                   one placeholder query (cart count) backed by a stub
src/shell/         useTabBarSync (badge + theme), placeholder page chrome (CSS module)
src/ui/            the NutUI wrappers (Popup, Toast, TextField). Pages never import NutUI (lint)
src/pages/…        4 tab pages; src/subpackages/demo/pages/ui: the UI-kit demo
src/test/          fake @tarojs/taro and @tarojs/components for Vitest, render helpers
project.config.json, .env.development, .env.production   AppID `touristappid` (placeholder)
```

A real AppID goes in the gitignored `apps/mini/.env.development.local` (or `.env.production.local`)
as `TARO_APP_ID`. Nothing in the build needs WeChat credentials.

### Scripts and turbo

| Script                     | What it runs                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `dev:weapp` / `dev:h5`     | `taro build --type … --watch --no-check`                                           |
| `build:weapp` / `build:h5` | `taro build --type … --no-check` → `dist/weapp`, `dist/h5`                         |
| `build`                    | `build:weapp && build:h5 && size`                                                  |
| `size`                     | `node scripts/size-report.mjs` (the gate below)                                    |
| `typecheck` / `lint`       | `tsc -p tsconfig.json` / `eslint .` (shared `@shop/config` preset, kind `tooling`) |
| `test:unit`                | `vitest run --project unit`                                                        |

**`build` builds both targets and gates the WeChat one.** The weapp package is the product. The
H5 build is what the e2e suite and the DIY preview will load, so a change that breaks it should
fail `build`, not the e2e job. Both builds together take about 12 s. `turbo.json` did not need
to change: `build` already caches `dist/**`, and Taro reads `.env*` itself, so turbo's strict
env mode loses nothing.

## What works (how it was checked)

- **WeChat package.** `dist/weapp/app.json` has the 4 pages, the `demo` sub-package, the native
  `tabBar` with its 4 texts, `lazyCodeLoading: "requiredComponents"`, `__usePrivacyCheck__: true`
  and `requiredPrivateInfos: ["chooseAddress"]`. `size-report` checks that every page it lists
  has its `.js/.json/.wxml`. It was not opened in WeChat DevTools: there is no DevTools on this
  Linux host.
- **H5.** `dist/h5` served over plain HTTP and was driven with Playwright (iPhone 13 profile):
  - the tab bar renders with the badge `3` on 购物车, and 首页 shows `购物车 3 件`;
  - navigating to `#/subpackages/demo/pages/ui/index` works;
  - typing into the NutUI input, opening the popup and the toast `你好，小明` all work;
  - there were no page errors.
- **Workspace imports.**
  - A type-only import from `@shop/contracts/cart/schemas` (`CartCount`).
  - A runtime import of `@shop/contracts/diy/removed` (`isRemovedStorefrontPage`, used by
    `openPage`). The removed-page list is present in `dist/weapp/common.js`.
  - `size-report` checks from the module list that no `zod` module is in the bundle.
  - ESLint allows `@shop/contracts` at runtime only for modules listed in `CONTRACTS_RUNTIME`;
    everything else must be `import type`.
- **One copy each** of `react`, `react-reconciler` and `@tarojs/runtime` in the WeChat bundle.
  `react-dom` does not appear, because Taro substitutes `@tarojs/react`. `size-report` proves
  this on every build from the webpack module list (`.bundle-stats/weapp.json`).
- **No dynamic code.** The WeChat output has no `new Function(` and no `eval(` (workaround 4), and
  every `.js` parses as ES2018 (workarounds 2–3).
- **Data layer.**
  - TanStack Query's `focusManager` follows `Taro.onAppShow/onAppHide`, and `onlineManager`
    follows `Taro.onNetworkStatusChange`, seeded from `getNetworkType`.
  - `useRefetchOnShow(queryKey)` refetches stale active queries on a page's second and later
    `useDidShow`, the mini-program's equivalent of a window-focus refetch.
  - A zustand store holds the cart count and the tab-bar theme.
- **Tests.** 10 tests in 4 files pass (details below).

Commands run at the end of the spike:

| Command                                                       | Result                      |
| ------------------------------------------------------------- | --------------------------- |
| `pnpm turbo run typecheck lint test:unit --filter @shop/mini` | pass                        |
| `pnpm turbo run typecheck lint test:unit build` (whole repo)  | pass, 36/36 tasks           |
| `pnpm --filter @shop/mini build` (both builds + `size`)       | pass                        |
| `pnpm exec prettier --check apps/mini docs/mini`              | pass                        |
| `pnpm guards`                                                 | pass, 14 checks, 0 failures |

## Workarounds

Each entry gives the symptom, the cause, the fix, and when the fix can be removed.

1. **`--no-check` on every `taro build`.** Taro's config doctor runs before each build:
   - it downloads a JSON schema from `raw.githubusercontent.com`;
   - it writes `~/.taro4.0/index.json`;
   - it rejects a `RegExp` in `compile.include`, which Taro's own docs allow and which
     workaround 2 needs;
   - after printing the error it **exits 0 without building**, so a build "succeeds" and leaves
     the previous `dist/` in place.

   This cost a debugging round: babel target changes looked ineffective. `--no-check` skips the
   doctor, so the build makes no network call and never passes silently. Remove it when the
   doctor stops rejecting valid configs and stops exiting 0 on failure.

2. **`compile.include`** (`config/index.ts`). Taro's script rule runs babel only over `src/` and
   over `node_modules` paths containing "taro". The fix adds two entries:
   - `packages/contracts/src`, because workspace packages are symlinked TypeScript source.
     Without it the build fails with "no loader for .ts".
   - `@tanstack/query-core`, `@tanstack/react-query` and `zustand`, which ship syntax newer than
     the target: private class fields, `??` and `?.`.

   When a new dependency fails the ES2018 check in `size-report`, it is added to this list.

3. **Explicit babel targets `{ ios: '12', chrome: '70' }`** (`babel.config.js`). Without a target,
   babel-preset-taro falls back to iOS 9 / Android 5 and polyfills far more than needed. The
   package's `browserslist` field is used by autoprefixer, not by babel-preset-taro. iOS 12 is
   the oldest JSCore that current WeChat supports well; the check in `size-report` is ES2018.
4. **`GlobalObjectPlugin`** (`config/global-object-plugin.ts`).
   - Cause: `@tarojs/runtime` (`dist/bom/window.js`) references `global`, so webpack injects
     its `__webpack_require__.g` runtime module, which is `new Function("return this")()`.
     WeChat's iOS JSCore rejects dynamic code, and the review team flags it.
   - Fix: the plugin replaces that runtime module with a `globalThis`/`window` lookup.
   - The `new Function(` scan in `size-report` fails the build if it comes back.
5. **H5 minifier corrupts private class fields.** Taro's H5 terser config sets
   `quote_keys: true`, which turns `#t` into `#"t"`, a syntax error in the browser. Transpiling
   the modern dependencies (workaround 2) removes the private fields, so no H5-specific fix was
   needed. H5 output is not gated at ES2018 (it contains `catch {}`); it only has to run in
   Chromium and WebKit.
6. **Prebundle and webpack persistent cache off.** Taro's esbuild prebundle only speeds up watch
   builds. It is a second module graph, and it can reintroduce what workarounds 2–4 remove
   (untranspiled dependencies, a second React). The persistent cache was turned off so every
   measured build is from scratch; a clean build takes 4–7 s. Turn the cache on for `dev:*` if
   watch start-up gets slow, then re-check the sizes and the single-copy proof.
7. **pnpm `allowBuilds`** (root `pnpm-workspace.yaml`). pnpm 12 refuses to install while any
   build script is undecided. All six new ones are `false`, each with a reason in the file:
   - `@tarojs/cli`'s postinstall contacts `taro.jd.com` and installs a plugin from a JD registry
     over HTTP;
   - `@tarojs/binding` compiles only from source;
   - `@swc/core` and `@parcel/watcher` use prebuilt binaries;
   - `core-js` and `core-js-pure` only print a banner.

   Nothing in the build needs any of these scripts.

8. **pnpm `overrides` drop two NutUI runtime dependencies.** `@nutui/nutui-react-taro` lists its
   docs-site tooling as runtime dependencies: `codesandbox` (which pulls in axios 0.18, inquirer
   and pacote) and `rehype-highlight`. Nothing in its `dist` imports either. `'-'` removes them.
9. **pnpm `hoistPattern` keeps `react` and `react-dom` out of the hidden hoist.** The workspace now
   has React 18 (mini) and React 19 (web). pnpm's hidden hoist (`node_modules/.pnpm/node_modules`)
   holds one copy of each name. Once `apps/mini` was added, it held React 18 **and** `@types/react` 18. Every package that uses React without declaring it resolved React 18 through the hoist,
   including antd, next and `@rc-component/*` for their `.d.ts`. `apps/web`'s typecheck broke
   (`'Suspense' cannot be used as a JSX component`), and its runtime could have broken silently.

   The fix excludes `react` and `react-dom` from the hoist, so an undeclared React import fails to
   resolve instead of picking the other app's copy. That exposed one real case,
   `@nutui/icons-react-taro`, which imports `react` and `@tarojs/components` without declaring
   them. It is fixed with a `packageExtensions` entry in the same file. This is the only hoist
   setting needed: no `public-hoist-pattern`, no `shamefully-hoist`, no `node-linker=hoisted`.
   Taro resolves its plugins and loaders from the isolated layout.

10. **One `@types/react` (19) for the whole workspace.** `@types/react` cannot be kept out of the
    hoist: antd's and next's `.d.ts` files find React's types only there, and web's typecheck
    depends on it. With two versions installed, the hoisted one is whichever pnpm picks.
    `apps/mini` therefore uses `@types/react@^19.3.0` with the React 18 runtime.
    - Cost: React-19-only APIs type-check in apps/mini.
    - Mitigation: ESLint bans `use`, `useActionState` and `useOptimistic` from `react` in
      `apps/mini`.
    - Not caught by lint: `<Context>` rendered as a provider, and `ref` passed as a plain prop to
      a function component. Both fail on the first render of any test that covers them.
    - `pnpm peers check` reports `@tarojs/taro` wanting `@types/react ^18`; that report is
      expected.
    - Remove this when Taro ships a React 19 reconciler.
11. **`TanStack environmentManager.setIsServer(() => false)`.** Query decides "server" from
    `typeof window`. Taro's ProvidePlugin supplies a `window` in the mini-program today, but that is
    an implementation detail of `@tarojs/runtime`. On the server path Query would never refetch or
    garbage-collect, so the adapter pins it.
12. **NutUI pinned to 3.0.19.** 3.0.20 depends on `@jmfe/npm-usage-stats-tool@latest`, which does
    not exist on the public registry (404). Check this again before bumping.
13. **NutUI on-demand imports by path.** The package has no `exports` map and no babel plugin is
    needed. The wrappers import `@nutui/nutui-react-taro/dist/es/packages/<name>` plus its
    `style/css`, which keeps the kit inside the sub-package that uses it.
    - NutUI styles are drawn for a 375 px design, ours for 750. `designWidth` is a function that
      returns 375 for files under `@nutui` (the NutUI docs' own recipe).
    - Optional NutUI props go through `defined()` so that `exactOptionalPropertyTypes` holds.
14. **CSS modules typed per file.** Taro's `className` does not accept `string | undefined`, which
    is what a generic `*.module.scss` declaration gives under `noUncheckedIndexedAccess`. Each
    module has a sibling `x.module.d.scss.ts` (`allowArbitraryExtensions`), so a class-name typo
    is a type error (TS2551). Codegen can replace the hand-written files once there are many.
15. **Bundle stats on every build** (`config/bundle-stats.ts`). The plugin writes the module list,
    with each module's output files, to `apps/mini/.bundle-stats/<platform>.json` (gitignored).
    It is always on: an env flag would be stripped by turbo's strict env mode, and the file is
    about 50 KB.
16. **H5 `performance.hints(false)`.** Webpack's 244 KiB hint does not apply to an e2e and preview
    build; the WeChat budget lives in `size-report`.

Peer warnings introduced by this app, all harmless:

- `@tarojs/plugin-framework-react` wants `vite ^4` (only for Taro's vite runner, unused);
- `@tarojs/webpack5-runner` wants `less ^4` (less 3.13 is installed; there are no `.less` files);
- `@tarojs/taro` wants `@types/react ^18` (workaround 10).

`@tarojs/webpack5-runner` also depends on `vm2` and `jsdom` at build time; neither reaches the
output. Adding the app changed only peer suffixes (`supports-color`, `jiti`, `jsdom`) in other
importers' lockfile entries. No resolved version changed.

## Size baseline

These numbers come from `node scripts/size-report.mjs` after a production `build:weapp`.

- A package counts every uploaded file (JS, WXSS, WXML, JSON, WXS, `LICENSE.txt`); source maps
  and `project.config.json` are left out.
- KB is 1024 bytes.
- WeChat's hard limits are 2 MB for the main package, 2 MB for each sub-package and 20 MB in
  total.
- The default budgets are main ≤ 1.5 MB, each sub-package ≤ 2 MB and total ≤ 8 MB. They are
  set with `--main-kb/--subpackage-kb/--total-kb` or `MINI_BUDGET_MAIN_KB`,
  `MINI_BUDGET_SUBPACKAGE_KB` and `MINI_BUDGET_TOTAL_KB`.

| Scenario                                                                       | Main     | `demo` sub | Total    | H5 JS / CSS        |
| ------------------------------------------------------------------------------ | -------- | ---------- | -------- | ------------------ |
| **A. As committed**: Popup + Toast + Input used only in the `demo` sub-package | 342.6 KB | 66.7 KB    | 409.3 KB | 575.8 KB / 21.3 KB |
| **B. No NutUI** (demo page renders plain text)                                 | 339.6 KB | 0.7 KB     | 340.3 KB | 484.9 KB / 2.5 KB  |
| **C. NutUI also used on 首页** (main package)                                  | 410.7 KB | 1.4 KB     | 412.1 KB | not measured       |

Reading the table:

- **The skeleton costs about 340 KB of the main package**: Taro runtime, React 18, TanStack
  Query, zustand and the app shell. That is 22 % of the 1.5 MB budget.
- For A, the main package is made up of:
  - `taro.js` 121.3 KB
  - `vendors.js` 135.1 KB
  - `base.wxml` 56.7 KB (Taro's template set)
  - `app.js` 15.4 KB
  - `common.js` 5.0 KB
  - the rest: `runtime.js`, per-page stubs and WXSS
- Raw module bytes before minification, for where the size comes from:
  - `@tarojs/runtime` 162 KB
  - `@tanstack/query-core` 147 KB (after babel)
  - `react-reconciler` 92 KB
  - `@tarojs/shared` 41 KB
  - `@tarojs/plugin-framework-react` 36 KB
  - `@tarojs/react` 32 KB
- **Three NutUI components cost about 67 KB in the package that uses them, plus 3 KB in the main
  package's `base.wxml` regardless of where they are used.** In A and B the kit stays in the
  sub-package (`optimizeMainPackage`). In C it moves into `vendors.js` (+71 KB main). Of that:
  - `react-transition-group`: 32 KB raw;
  - `@nutui/icons-react-taro`: 30 KB raw. It is a single file, so importing one icon imports
    all of them.
- H5 is not budgeted. Each tab page chunk there repeats about 35 KB of shared code. Worth a look
  when S4 measures e2e load times; it does not affect WeChat.

## Tab bar: native `tabBar` + `setTabBarStyle` / `setTabBarBadge` (implemented)

**Recommendation: the native tab bar.**

- Pages: fixed in `app.config.ts`, from `src/platform/tab-pages.ts`.
- Theme: the DIY colours are applied with `setTabBarStyle`.
- Cart count: shown with `setTabBarBadge` / `removeTabBarBadge`.
- `useTabBarSync()` runs in each tab page. On `useDidShow` it re-applies the theme and the badge,
  and it re-applies them when either changes while the page is shown. The page's cart-count query
  refetches when the page is shown again.
- Tab-bar calls are only made from tab pages, because WeChat rejects `setTabBar*` from a non-tab
  page. Errors are swallowed in `src/platform/tab-bar.ts`, because the tab bar is decoration and
  must never break a page.

Why not `custom-tab-bar` (`tabBar.custom: true`):

- **Selected state drifts.** WeChat creates a separate custom-tab-bar instance for each tab page,
  not one shared bar. Each instance starts with whatever `selected` it was built with. So after a
  `switchTab` the new page's bar shows the old tab until code runs. The common symptom is that
  the highlight lags one tap behind or flickers. The documented fix is to call
  `this.getTabBar().setData({ selected })` in every tab page's `onShow`. In Taro React that means
  `Taro.getCurrentInstance().page.getTabBar()` from `useDidShow`, which returns `undefined` until
  the bar has attached, and which behaves differently on H5.
- **State and context do not cross.** The bar is a separate component tree. It sees neither
  React context nor the QueryClient, so badge counts need a global store.
- **Cost.** It is main-package code rendered by Taro's runtime on every tab page, where the native
  bar costs nothing.
- **H5 support** in Taro for `custom: true` was not verified, and the e2e suite runs on H5.

If a custom bar is ever needed, the fix pattern is:

- derive `selected` from the current route, not from component state;
- keep the badge and theme in the zustand shell store;
- have each tab page's `useDidShow` call a single `syncCustomTabBar()` in `src/platform/` that
  pushes `{ selected, badge, theme }` to `getTabBar()` and retries on the next tick when it is
  `undefined`;
- keep the bar component stateless.

**Parity gap to decide (not a Taro problem).** Today's uni-app storefront uses neither pattern:

- `App.vue` calls `uni.hideTabBar()`, and each tab page renders `components/pageFooter`, a
  DIY-configured footer.
- The footer's links may point at non-tab pages (it falls back to `redirectTo`).
- Its icons come from the server.
- It has icon-only and text-only styles.

The native bar can take the DIY colours and texts, and icons through `setTabBarItem`. Those icons
must be local files; downloading them to temp files first is plausible but **was not tested on a
device**. It cannot take arbitrary links, a different number of tabs, or icon-only/text-only
styles.

If product needs those, use `custom-tab-bar` with the fix pattern above. Do not use the
in-page-footer pattern. It remounts a footer on every page and flashes the native bar on a cold
start before `hideTabBar` runs.

## Test approach

- **Runner.** Vitest (`vitest.config.mts`, one `unit` project) with happy-dom,
  `@testing-library/react` 16 on React 18, and oxc's automatic JSX runtime. CSS modules map
  to their plain class names.
- **`@tarojs/taro` → `src/test/taro-fake/taro.ts`** (alias). A small hand-written fake of the
  API the app uses, which records every platform call in `taroFake.calls`. Tests drive the
  platform with:
  - `showApp` / `hideApp`
  - `setNetwork(online)`
  - `showPage` / `hidePage`

  `useDidShow` runs on mount and on `showPage()`; `useDidHide` and `useLoad` are also provided.
  `taroFake.reset()` runs after each test.

  Why a fake rather than Taro's own H5 implementation: `@tarojs/taro-h5` wires its hooks to its
  router and page stack during the webpack build. Outside that build `useDidShow` has no page to
  attach to, and the lifecycle tests need to fire show/hide on demand.

- **`@tarojs/components` → `src/test/taro-fake/components.tsx`** (alias). Plain DOM elements for
  the components the app uses: View, Text, Button, Input, Image, ScrollView, Swiper and
  SwiperItem. `Input` reports `onInput` as `{ detail: { value } }`, as Taro does. Taro's real H5
  components are Stencil web components. That matters for e2e selectors: an H5 input is a
  `taro-input-core` around an `<input>`, so query by role, not by placeholder.
- **The tests (10, in 4 files):**
  - `pages/home/index.test.tsx` (component):
    - 首页 shows `购物车加载中`, then `购物车 3 件`;
    - it puts badge `3` on tab index 2;
    - it applies the tab-bar style;
    - its button navigates to the sub-package page.
  - `data/use-refetch-on-show.test.tsx` (hook): with the Query adapters and the fake lifecycle,
    a stale query refetches when the page is shown again, and a fresh one does not.
  - `data/query-client.test.ts`:
    - `installQueryAdapters` drives `focusManager` from app show/hide and `onlineManager` from
      network changes, seeded from `getNetworkType`;
    - it pins `isServer` to `false`;
    - its uninstall removes every platform listener.
  - `platform/navigation.test.ts`: `openPage` navigates to a shipped page and drops a link to a
    retired page, which proves the `@shop/contracts` runtime import under test too.
- **Not covered here:** the NutUI wrappers render NutUI's own Taro components, which import the
  real `@tarojs/components`. Under the alias they get the fakes. That is enough for a smoke render
  but not for NutUI's own behaviour, which the H5 e2e run checks. Move the fake to
  `@shop/testing/taro` when `packages/storefront-blocks` needs it.

## Risks

1. **Taro's release cadence and JD-hosted tooling.**
   - The CLI's install and doctor steps contact JD and GitHub hosts. Both are neutralised here
     (`allowBuilds: false`, `--no-check`), and every Taro upgrade must re-check that.
   - Pin `@tarojs/*` exactly and upgrade them as one set.
2. **React 18 for as long as Taro stays on reconciler 0.29.** Shared React code between apps/web
   (19) and apps/mini (18) must stick to the common subset. This is covered by workaround 10's
   lint rule and by the tests. The hoist exclusion (workaround 9) must stay: without it the next
   undeclared React import in either app silently gets the wrong copy.
3. **Main-package growth.** The skeleton already uses 340 KB. The real 首页 with DIY blocks, 分类,
   购物车 and 我的, plus login and privacy, has to fit in the remaining 1.2 MB of the budget.
   - Keep NutUI and heavy blocks out of tab pages, or accept about 70 KB per three components.
   - `size-report` names the heaviest packages on every build.
4. **Transpiling dependencies is opt-in** (workaround 2). A new dependency with modern syntax
   fails the ES2018 gate at build time, not on a phone. That is the intended behaviour, but it
   means adding to the list each time.
5. **Not verified on a device or in DevTools.** Not checked:
   - `setTabBarItem` with downloaded icons;
   - the `__usePrivacyCheck__` flow with a real `chooseAddress`;
   - `lazyCodeLoading` behaviour;
   - real iOS JSCore.

   The ES2018 and no-`eval` gates remove the usual iOS failures, but a DevTools upload of this
   build with a test AppID is the first thing to do.

6. **NutUI quality.**
   - It ships docs tooling as dependencies (workaround 8).
   - Its latest patch release is uninstallable (workaround 12).
   - One package (`icons-react-taro`) has undeclared dependencies (workaround 9).
   - Its Toast is scoped per page path through `eventCenter`, so each page that toasts needs its
     own `<ToastHost />`.

   Keeping it behind `src/ui/` (lint-enforced) keeps it replaceable.

## GO / NO-GO

**GO**, on these conditions:

1. The workarounds above stay, each with its check:
   - `--no-check` on every `taro build`;
   - `GlobalObjectPlugin`, with the `new Function`/`eval` scan;
   - explicit babel targets and `compile.include`, with the ES2018 parse;
   - the `hoistPattern` exclusion and the single `@types/react`, with web's typecheck and the
     single-copy proof.

   `size-report` runs in `build`, so turbo and CI enforce all of them.

2. Before feature work starts, upload `dist/weapp` once through WeChat DevTools with a test
   AppID (from `.env.*.local`, never committed) and check on a real iOS and Android device:
   - the app starts;
   - the four tabs, the badge and a `setTabBarStyle` theme work;
   - the sub-package page and the NutUI popup and toast work.
3. Product decides the tab-bar parity question: native tab bar with DIY colours, texts and
   icons, or `custom-tab-bar` for arbitrary links and styles. The native bar is implemented;
   switching costs about a day using the fix pattern above.
4. The main-package budget stays at 1.5 MB in `size-report`, and a page or block that needs NutUI
   lives in a sub-package unless the budget allows otherwise.

## Open questions

- Can `setTabBarItem` use an icon downloaded at runtime? This decides whether DIY bottom-nav
  icons work on the native bar.
- Does the rewrite keep the DIY footer's non-tab links and icon-only/text-only styles (see the
  parity gap)? This goes to S5 or product.
- Should `@shop/testing` get the Taro fake now, or when the shared storefront blocks (S3) need it?
- For CI: `build` runs both targets (about 12 s warm). If CI minutes matter, split out `build:h5`
  so only the e2e job runs it.
