# K2 (mini-program size and runtime performance) — status

Branch `storefront/mini-K2-size-perf`, based on `storefront/mini` @ f0a0b50.
Brief: `docs/mini/next-tasks.md` § K2-size-perf. It has four parts: the main-package breakdown,
the package layout, a runtime review, and budgets that fail the build.

## Done

### 1. Breakdown of the production weapp main package

`pnpm --filter @shop/mini build:weapp` (production; `dist/weapp`; bytes WeChat uploads).

| Package   | Before (f0a0b50) | After (this branch) | Budget  |
| --------- | ---------------- | ------------------- | ------- |
| main      | 703.3 KB         | **682.0 KB**        | 1536 KB |
| goods     | 22.4 KB          | 22.4 KB             | 2048 KB |
| order     | 99.1 KB          | 99.9 KB             | 2048 KB |
| aftersale | 51.2 KB          | 51.2 KB             | 2048 KB |
| promo     | 69.9 KB          | 70.7 KB             | 2048 KB |
| account   | 120.1 KB         | 120.1 KB            | 2048 KB |
| content   | 14.9 KB          | 14.9 KB             | 2048 KB |
| page      | 3.6 KB           | 3.6 KB              | 2048 KB |
| total     | 1084.5 KB        | **1064.7 KB**       | 8192 KB |

The "last measured" figures in the brief (main about 656 KB, total about 1 MB) were E's; J1–J3
and H5 added the rest before this branch.

What the 682.0 KB main package holds (files in `dist/weapp` outside `packages/`):

| File                        | Size     | What                                                                                             |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `common.js`                 | 159.4 KB | the kit (`src/ui`), the 22 decor blocks, `platform/`, `features/` the main pages use, api-client |
| `taro.js`                   | 121.7 KB | `@tarojs/runtime`, `shared`, `plugin-framework-react`, `react`, `plugin-platform-weapp`          |
| `app.js`                    | 106.2 KB | `react-reconciler`, TanStack Query's client and caches, `app.tsx`                                |
| `base.wxml`                 | 83.4 KB  | Taro's recursive templates (16 levels); 14 KB of it is the `aria-*` bindings (a11y-plugin)       |
| `common.wxss`               | 81.4 KB  | the kit's and blocks' styles; icons 16.1 KB, empty-state drawings 6.5 KB (were 31.2 and 12.7)    |
| `pages/*` (7 pages)         | 62.7 KB  | the 4 tabs, product detail, login, agreement: js, wxss, wxml, json                               |
| `vendors.js`                | 51.7 KB  | TanStack Query observers, `tslib`, `react`, `@babel/runtime`, zustand                            |
| tab-bar PNGs (8)            | 6.2 KB   | 575 B – 1 KB each                                                                                |
| app.json, runtime.js, other | 9.4 KB   |                                                                                                  |

By owner, in raw module bytes before minification (the end of every `size-report` run prints this):
`@tarojs/runtime` 161.9 KB, `@tanstack/query-core` 157.3 KB, `src/ui` 132.1 KB, the blocks
128.2 KB, `react-reconciler` 91.6 KB, `src/pages` 80.1 KB, `src/features` 77.2 KB, `src/platform`
64.0 KB, then Taro's `shared`, `plugin-framework-react`, `react` and the contracts' zod-free
`decor` modules (20.1 KB).

The checklist was checked on the build, and each item is now a failure in `size-report`:

- **No zod.** The module list has none (this was already checked).
- **No `eval` or `new Function`.** Already checked; none.
- **No admin routes.** No `/admin-api` path or `*.admin*` route id in any file. The api-client's
  catalogue is storefront-only. **New check.**
- **No demo subpackage.** `app.json` has 7 sub-packages. `subpackages/` is absent, and no module
  from `src/subpackages/` is in the build. **New check.** `TARO_APP_DEMO=1` accepts it for a
  phone-only gallery build.
- **No source maps.** No `.map` file and no `sourceMappingURL`. **New check.** Before this,
  `.map` files were only left out of the byte count.
- **No test fixtures.** Nothing from `src/test/`, `*.test.*`, `*fixture(s).*`, `@shop/testing`,
  or the test tooling (`@testing-library`, `happy-dom`, `vitest`, `msw`). **New check.** The e2e
  emulation markers were already checked.

### 2. Package layout

- **Main pages.** `app.pages.ts` `MAIN_PAGES` holds the 4 tabs, product detail, login and the
  agreement (privacy) page, and nothing else. It was already right.
- **NutUI.** It is imported nowhere today: 0 bytes of `@nutui` in the build. Only the
  `--nutui-*` token bridge ships (about 2 KB of `app-origin.wxss`). Two new checks:
  - lint refuses the bare `@nutui/nutui-react-taro` import, so the kit has to import per
    component (`…/dist/es/packages/<name>`);
  - `size-report` fails if NutUI's whole-library entry or its whole stylesheet reaches the build.
- **Sub-package-only code.**
  - `config/bundle-stats.ts` now records, for each module, which packages' entries reach it
    through the import graph (`usedBy`).
  - `size-report` fails when a module in the main package is used only by sub-packages. It found
    none: Taro's `optimizeMainPackage` already moves those into `sub-common/`, for example
    `ui/countdown` (order and promo), `lib/money` and `data/upload`.
  - I also tried `"sideEffects": ["*.scss", "*.css"]` in `apps/mini/package.json`, so the
    `@/platform` barrel would not carry unused modules. It saved 1.2 KB in the main package and
    cost 7 KB in total, because modules were duplicated into sub-packages. Not kept.
- **Icons** (commit 28be4dd).
  - Each icon class and each empty-state drawing sets a custom property (`--shop-icon`,
    `--shop-art-*`), and one rule hands it to both `-webkit-mask-image` and `mask-image`. The
    SVG data URL used to be written twice per icon.
  - `common.wxss` went from 105.1 KB to 83.4 KB, and the main package down by 21.3 KB. The
    pictures are the same.
  - The tab-bar PNGs are already small: 6.2 KB for all 8.

### 3. Runtime review

- **Round trips before the first screen.**
  - 首页 needs one request, `decor.pageHome`. Block data comes resolved in the same response.
  - `app/config`, `user.recordVisit` and, when signed in, `cart.count` run in parallel. None of
    them blocks painting. The theme comes from the stored copy.
  - A returning shopper's token is restored in `onLaunch`, so the first request carries it.
  - A first-time visitor gets the page anonymously, then once more after the silent sign-in.
    The second request does not delay the first paint.
  - Two other pages take more round trips (written up below): 分类 (two in a row) and 商品详情
    (one, then a second wave).
- **`setData` for long lists.**
  - `InfiniteList` appends through Taro's `appendChild`, which sends only the new items'
    paths (`cn.[i]`), not the list.
  - What did cost was a countdown per unpaid-order card. Each card ran its own 1 s interval, so
    each second brought one render and one `setData` per card. The intervals also kept running
    under a pushed page. Commit 88f0417 fixes this:
    - `ui/second-ticker.ts` runs one shared interval, and React batches the ticks into one
      render and one `setData`;
    - `usePageShown()` stops a countdown while its page is hidden, and it catches up on show;
    - the new unit tests are in `ui/countdown.test.tsx`.
- **Image `lazyLoad`.**
  - The kit's `Image` defaults to `lazyLoad`. It turns it off only for the first screen:
    product and activity heroes, the splash, the 拼团 banner and the team hero.
  - The product-grid, article-list and campaign-card blocks are lazy.
  - image-cube, hotspot-image, carousel and nav-grid are not (written up below).
- **Thumbnails.** There are none. Lists load the original upload (backend gap below).
- **Timers.**
  - Countdowns: fixed, as above.
  - `SmsCodeField` keeps its 60 s resend timer while hidden. That is correct, because the wait
    is real time. Its page belongs to H6 anyway.
  - The splash timer runs only on 首页, and only while the splash shows.
  - 支付结果 polling is capped by `POLL_LIMIT_MS`.
  - `use-presence` timers are 16 ms and 150 ms, and clean up.
- **`useDidShow` refetches.**
  - `useRefetchOnShow` refetches only stale (30 s), active queries under its own key. One call
    fetches a key once, however many observers it has.
  - A tab switch costs, at most:
    - `cart.count`;
    - on 我的, `decor.pageUserCenter` and the unread count as well;
    - on 首页 and 商品详情, the visit report: a `POST /visits` on show and another on hide.
  - One real refetch storm is written up below: infinite lists that refetch on show.

### 4. Budgets

- `build:weapp` now runs `scripts/size-report.mjs` after `taro build`. A production weapp build
  over budget fails on its own:
  - main ≤ 1536 KB;
  - each sub-package ≤ 2048 KB;
  - total ≤ 8192 KB.
- Before this, only `build` ran the report. `build` is now `build:weapp && build:h5`.
- `scripts/device-build.mjs` already runs the report.
- **New baseline** (this branch): main **682.0 KB**, total **1064.7 KB**, the largest
  sub-package `account` at 120.1 KB. It is recorded here and in `docs/mini/README.md` §2.

## In progress

Nothing.

## Pending

Nothing in the brief. The items under "Written up" are for the orchestrator to dispatch or drop.

## Page-form changes (旧→新)

None. Nothing a shopper sees has changed:

- the icons and drawings are the same pictures, drawn through a custom property;
- a countdown shows the same time. It only stops rendering while nobody can see it.

The device check should still confirm the icons on a phone (see "Tests for the orchestrator to
run").

## Written up, not changed (each would touch what a shopper sees, or another stream's pages)

1. **分类 waterfall.** `catalog.categoryTree`, then `catalog.productList` for the first category:
   two round trips in a row before the right-hand list shows.
   - Option: the tree response carries the first category's first page.
   - Option: start the list with the stored last category.
2. **商品详情 second wave.** The groupbuy/presale entry, 领券, 评价 and 为你推荐 start only after
   `catalog.productDetail` returns, though all but 评价 need only the product id.
   - `queryClient.prefetchQuery` for those in `ProductPage` would bring them one round trip
     sooner. The first screen does not change.
   - This is a page edit (K3's page), so it is not made here.
3. **Infinite lists that refetch on show** (`order.list`, `refund.myList` via `useRefetchOnShow`).
   Once stale, coming back refetches every loaded page one after another (TanStack's
   infinite-query refetch). Ten pages scrolled means ten requests.
   - Option: `maxPages`.
   - Option: refetch only page 1 and drop the rest. This changes the scroll depth a shopper
     returns to.
4. **Blocks without `lazyLoad`.** image-cube and hotspot-image, and carousel slides after the
   first.
   - image-cube cells have a fixed ratio, so `lazyLoad` is safe there. It is also harmless on
     the first screen, since WeChat loads everything within three screens.
   - `widthFix` pictures (the hotspot image, the image-cube rows) have no height until they load.
     Making them lazy would make the page jump.
   - The blocks package is shared with the admin canvas and the fidelity screenshots, where
     `loading="lazy"` can leave off-screen pictures unloaded. So it is not changed here.
5. **`Image` sets `shop-image--loaded` on load.** Every picture in a list sends its own `setData`
   (a class change) when it arrives.
   - Dropping the state would keep the grey backing behind transparent or `contain` pictures.
     That is a visible change.
6. **The poster canvas in the main package** (`features/share/poster-*`, `platform/poster*`, about
   20 KB raw). It is there because 商品详情 uses it (D's decision).
   - It could move to `promo` with 分包异步化 (`componentPlaceholder`), as design.md first
     planned.
   - Not needed under the budget.
7. **The re-applied tab-bar look.** `useTabPage` calls `setTabBarStyle` and 4 × `setTabBarItem` on
   every tab show.
   - Skipping an unchanged look would save 5 bridge calls per switch. Whether WeChat resets the
     tab bar on `reLaunch` has to be checked on a device first.
8. **`base.wxml` (83 KB).** It is Taro's 16-level template set. Lowering `mini.baseLevel` would
   shrink it, but pushes deeper trees through the slower `comp` fallback. Not worth it now.

## Backend gaps

- **Thumbnails.** Uploads are served as is (`/uploads/…`, or S3 with no image-processing
  parameters). The storage config has no resize step, so product cards, cart rows and order rows
  download full-size originals.
  - Option: generate thumbnails (for example 360 px and 750 px) at upload time.
  - Option: an image-processing parameter per driver (Aliyun OSS `x-oss-process`, COS
    `imageMogr2`), exposed as `assetUrl(path, { width })`.

## Open questions

- **Sub-package budget: 1 MB or 2 MB?**
  - The brief says each sub-package ≤ 2 MB, and the gate enforces 2048 KB, as it did before.
  - `wechat-compliance.md` C13, `pages.md` §1 and the `app.config.ts` comment say ≤ 1 MB.
  - Every sub-package is at most 120 KB, so either passes. Pick one and align the docs or
    `--subpackage-kb`.
- `@nutui/nutui-react-taro` is a dependency with no importer, plus a 2 KB token bridge. Keep it
  for later kit components, or drop both?

## Tests for the orchestrator to run

- `pnpm --filter @shop/mini build` (weapp with the gate, then H5). I did not build H5 here. The
  CSS change (custom properties for masks) also reaches the H5 and emulation builds.
- `pnpm --filter @shop/e2e-storefront test:mini`. No spec changed. It covers the countdowns in
  拼团 and 支付 pages, and the icons in the emulation build.
- Device check (device-check.md), which I could not run here:
  - D12: sizes against `size-report`;
  - icons and empty-state drawings on iOS and Android (`--shop-icon` inside `mask-image`; base
    library ≥ 2.x);
  - an unpaid order's countdown in 订单列表, after coming back from 订单详情.

## Checks run here

- `build:weapp` (production, about 20 s each), 9 runs, one at a time:
  - the baseline;
  - 6 while developing the import-graph walk (2 of them stopped in the config, before compiling);
  - the `sideEffects` trial;
  - the final build. `size-report: ok`.
- `size-report` against a doctored copy of `dist/weapp` and the module list: a source map, a
  `sourceMappingURL`, an admin path, the demo sub-package, a `src/test/` fixture, a
  `src/subpackages/` module, NutUI's whole entry, and a main-package module only `order` and
  `promo` use. Each failed as it should. `TARO_APP_DEMO=1` accepted the demo package. The budget
  flags (`--main-kb 600`) failed with exit 1.
- `pnpm --filter @shop/mini typecheck` and `lint`: clean. Lint refused a probe file that imported
  the bare `@nutui/nutui-react-taro`.
- Unit tests (`--maxWorkers=2`): `ui/countdown.test.tsx` (2 new), `ui/order-card.test.tsx`, and
  the page tests of 收银台, 订单详情, 订单列表, 拼团详情, 拼团进度 and 预售详情. 59 passed.
- `prettier --check` on the changed files.
