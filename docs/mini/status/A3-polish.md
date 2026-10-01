# Stream A3: mini-program polish (status)

Worktree `x-zoo-mini-wt/A3-polish`, branch `storefront/mini-A3-polish` (from `storefront/mini`).
Five small fixes, one commit each. Updated at every commit.

## Done

- **Tab bar icons.** `scripts/tab-icons.mjs` (plain node: strokes on a 24-unit grid, analytic
  anti-aliasing, `node:zlib` PNG; `pnpm --filter @shop/mini tab-icons`, `--check` to compare)
  draws 首页 / 分类 / 购物车 / 我的 into `src/assets/tab-bar/<icon>.png` and `<icon>-active.png`:
  81 × 81, 575–1009 B each (6.4 KB for the eight). Unselected `#666666`, selected the default
  theme's `primaryText` (`#E1251B`) with a light fill, so the state is not colour alone.
  `TAB_PAGES` names the icon; `app.config.ts` sets `iconPath` / `selectedIconPath`. Taro copies
  them into `dist/weapp/assets/tab-bar/` and inlines them as data URIs on H5.
  `applyTabBarLook` still takes a shop's uploaded icons (downloaded, then `setTabBarItem`); an
  icon that is not uploaded or fails to download now goes back to the bundled one
  (`bundledTabIcon`), so removing an upload takes effect. Main package 639.2 → 646.4 KB
  (+7.2 KB) at this commit; total 855.7 → 862.9 KB.
- **Spec text.** `lib/spec.ts` `formatSpec` (`白|L` → `白 / L`, empty values dropped) is the one
  formatter; used by `ui/order-card.tsx` (订单列表 / 详情 lines), 售后 apply / detail / card,
  确认订单, 购物车, 已选 (sku-select) and 商品评价, replacing four inline `replace`s and four raw
  prints.
- **Product card role.** `packages/storefront-blocks` `ProductCards` (商品列表 / 商品选项卡 in
  every layout): a card that opens its product carries `ariaRole="link"` and
  `ariaLabel="<title>[，已售罄]"`, as the kit's `ProductCard` does. The DOM shim renders
  `ariaRole` as `role` on `View`, so the admin canvas and the block tests see it
  (`getByRole('link', { name })`).
- **Login return.** `platform/nav.ts` `loginReturn(target, getCurrentPages())` decides, and
  `returnFromLogin` does: `navigateBack` when the page under 登录 is the redirect target (same
  catalogue path, same declared params, read from WeChat's `options`, Taro's `$taroParams` or
  the H5 `path` query, a mini-program code's `scene` included; a tab without params), else
  `navigate(target, { replace: true })` as before. Unit-tested (WeChat and H5 stack shapes,
  scene, other product, first page, tabs). WeChat semantics, reasoned from the docs (no device
  here): `redirectTo` closes the current page and opens a _new_ instance, so 商品 → 登录 →
  `redirectTo(商品)` left `[商品, 商品]` on WeChat as well as H5; `navigateBack({ delta: 1 })`
  closes 登录 and shows the existing 商品 instance (`onShow`, state kept). WeChat's
  `getCurrentPages()` pages carry `route` (no slash) and `options`; Taro's H5 router's carry
  `route` and `path` with the query. Device item **D13** in `docs/mini/device-check.md`; D02
  now checks the icons too.
- **X-Client-Version.** `config/index.ts` fixes `process.env.TARO_APP_VERSION` at build time:
  the `TARO_APP_VERSION` variable when set, else `apps/mini/package.json` `version` (also the
  upload version in `scripts/preview.mjs`), checked against the server's `clientVersion` shape
  (a bad one fails the build). `data/api.ts` `CLIENT_VERSION` reads it, so every request and
  upload sends it. `package.json` goes from `0.0.0` to `1.0.0` (the first release; change it
  if the release plan says otherwise). `turbo.json` declares `TARO_APP_VERSION` for `build`
  (strict env mode). How to bump per release: `docs/mini/device-check.md` §9, pointed to from
  `docs/contributing.md`. Tested in `data/api.test.ts` (Vitest sets `1.0.0-test`).

- **Screenshot.** [`A3-polish/tab-bar-375.png`](A3-polish/tab-bar-375.png): 分类 at 375 px,
  DPR 2, from the H5 build with the API unreachable (hence 加载失败), showing the four icons with
  分类 selected.

## Checks (2026-09-24, at the last feature commit)

- `pnpm turbo run gen typecheck lint test:unit build`: everything passed except one
  `@shop/web#test:unit` case, `product-editor.test.tsx` 「offers the shipping templates as a
  select…」, which timed out at 120 s, and a Vitest fork for `crud-table.test.tsx` that did not
  start (「Timeout waiting for worker to respond」), with other streams' builds running on the
  same machine. Neither file is touched here. `pnpm turbo run test:unit --filter @shop/web` on its
  own then passed: 63 files, 857 tests. `@shop/mini`: 72 files, 315 tests; size-report ok.
- `pnpm --filter @shop/e2e-storefront test:mini`: 11 passed.
- `pnpm exec prettier --check .`: clean. `pnpm guards`: 15 checks, 0 failures.
- Weapp sizes: main 639.2 → 647.4 KB (+8.2 KB: 6.4 KB of icons, the rest code); total 855.7 →
  864.0 KB.

## In progress

- Nothing.

## Next

- Review and the merge into `storefront/mini`. Device items: D02 (icons, upload override) and D13
  (login return) in `docs/mini/device-check.md`.
