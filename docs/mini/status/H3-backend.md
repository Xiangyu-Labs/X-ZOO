# H3 (backend follow-ups, contract owner) — status

Branch `storefront/mini-H3-backend`, worktree `/home/xiangyu/Projects/x-zoo-mini-wt/H3-backend`.
Brief: `app/config` gaps → `deriveTheme` into contracts → 小程序码 `env_version` → fake "device
mode" → docs/mini cleanup → `diyThemeTokens` typing → merge checklist.

Merged `storefront/mini` at 299956592 (G1 decor blocks) before touching the decor-typed splash link.

## Done

1. `GET /api/v1/app/config` gaps (stream A's report)
   - `serverTime` (instant). **Outside the ETag**: stamped per request after the Redis cache
     (cache key bumped to `app:config:v2`), never moves `version`; also sent as the
     `X-Server-Time` header on every answer, 304 included (a 304 has no body). SYS-017.
   - `subscribeScenes`: contract enum `appSubscribeScene` (`checkout`, `groupbuyCheckout`,
     `presaleCheckout`, `refundApply`, `returnShipment`) → ≤3 template ids each, built in
     `subscribeScenesOf` (core) from the existing `wechat-oa-runtime` lists — the mapping
     stream A kept in `templatesByScene`. `subscribeTemplates` kept (deprecated for the mini).
     SYS-018.
   - `webviewDomains`: new `wechat-mini.webviewDomains` textarea (业务域名, one per line), bare
     host names only, refused whole otherwise. SYS-019.
   - `appearance.theme.accentColor` (`#RRGGBB | null`): new `storefront-appearance.accentColor`,
     blank = `null` = use the primary colour. SYS-015 extended.
   - `splashAd.link` is a `LinkTarget | null`: new `site.splashLinkTarget` (json field); falls
     back to the legacy `splashLink` as `webview` when it is https, else `null`. `site/config`
     unchanged. SYS-020.
   - `apps/mini/src/test/app-config-fixture.ts` gained the new fields (typecheck only).

2. `deriveTheme` into contracts
   - `packages/contracts/src/system/theme.ts`: colour maths + `deriveTheme` + `themeStyle` +
     `RADIUS_FACTOR` moved unchanged from `apps/mini/src/theme/{color,derive}.ts`, plus
     `themeInputOf(appearance.theme)`. Zod-free at runtime (type imports only; a test checks).
     `system/` rather than design.md's `diy/theme.ts`: it derives `app/config`'s appearance, and
     `diy` is the legacy domain. SYS-021; design.md §3.3 updated.

3. 小程序码 `env_version` (H2's open question)
   - `wechat-mini.codeEnvVersion` (`release` default | `trial` | `develop`, select on the
     settings screen) → `getwxacodeunlimit`'s `env_version`, both endpoints.
   - Cached per version with **no migration**: a non-release code's row has page
     `<env>:<page>`. The unique key stays `(page, scene)` because the previous image (rollback)
     inserts with `ON CONFLICT (page, scene)`; changing the index would break it.
   - Fake OA refuses an unknown `env_version` (40097). SHARE-003; C11 updated.
   - (The config field itself landed in the task-1 commit, alongside `webviewDomains`.)

4. Fake "device mode" (device-check.md option B)
   - `startFakeOaServer({ deviceMode })`, off by default: an unseeded, well-formed code
     (`DEVICE_CODE`, 16–128 of WeChat's alphabet) redeems to `odev_<hash>` / a `139…` phone;
     `{ openid, phone }` pins one shopper. Seeded codes win, malformed → 40029, still
     single-use. Unit tests in `fake-oa-server.test.ts`.
   - `e2e/storefront/scripts/serve.ts`: `SHOP_E2E_WECHAT_DEVICE=1` (+ optional
     `…_OPENID` / `…_PHONE`); never set by the suite. device-check.md (backend B, D04, D05) and
     the e2e README updated.

5. docs/mini cleanup
   - pages.md: real ids (`system.appConfigGet`, `decor.page*`, `wechat.shareMiniCode`,
     `payment.wechatReceipt`) in §2 and §5; §5 rows marked done where they are; the unbuilt
     app/config switches (二级类目, 商品详情 评价/推荐/服务标签) called out as not done.
   - design.md: `ThemeRoot` / `platform/theme.ts` → the real `theme/store.ts`,
     `ui/tokens/nutui-bridge.scss`, `platform/tab-bar.ts`; Countdown's 304 header.
   - decor.md note on ids; wechat-compliance C08 / C12 backend parts marked done.

6. `diyThemeTokens` typing — **not done, by decision** (design.md §3.2 rewritten, decor.md §9):
   the v2 token set is `storefront-appearance` / `app/config.appearance`, already typed
   (now with `accentColor`). The legacy bag stays `Record<string, unknown>`: renaming
   `theme` → `primary` breaks the live uni-app (`pageColorStatus` reads `tokens.theme`), a
   narrower TS type over unvalidated stored data would be a lie, and a zod schema would change
   what the legacy `PATCH /admin-api/diy/themes/:id` accepts.

Final checklist (2026-09-24, at dab47f5cc + this status commit): `turbo gen typecheck lint
test:unit build` (45/45), `test:int --force --concurrency=4` (core 1508, web 324, worker 6,
testing 9), `prettier --check .`, `check:examples` (461 routes), `pnpm guards` (15/0), uni-app
`npm ci --ignore-scripts && npm test` (477 passed, 32 skipped), `test:mini` (1) — all pass.
Not run (outside the brief's list): admin e2e, H5 storefront e2e, a real-device pass.

## In progress

- Nothing. Ready for the coordinator.

## Client follow-ups (stream A)

- `app-config.ts`: drop `templatesByScene`; `setSubscribeTemplates(config.subscribeScenes)`;
  `SubscribeScene` = `import type { AppSubscribeScene } from '@shop/contracts/system/app.schemas'`.
- `setWebviewDomains(config.webviewDomains)` in `applyAppConfig`.
- `setServerTime(Date.parse(config.serverTime))` on a 200; on a 304 read the `x-server-time`
  header (the api-client does not surface headers today — read it in the platform transport).
- Theme: `apps/mini/src/theme/derive.ts` and `color.ts` become
  `export * from '@shop/contracts/system/theme'` (delete `derive.test.ts`, now in contracts), add
  `'@shop/contracts/system/theme'` to `CONTRACTS_RUNTIME` in `apps/mini/eslint.config.mjs`,
  and `theme/store.ts` calls `deriveTheme(themeInputOf(appearance.theme))` (picks up the accent).
  Not done here: it is three files plus the lint allow-list, not a one-line swap.
- Splash: `splashAd.link` is a `LinkTarget` (`linkTargetRoute` / `openExternalLink` for `webview`).
