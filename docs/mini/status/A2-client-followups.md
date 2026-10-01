# A2 (client + test-infra follow-ups) — status

Branch `storefront/mini-A2-client-followups`, worktree
`/home/xiangyu/Projects/x-zoo-mini-wt/A2-client-followups`. Brief: H3's "Client follow-ups
(stream A)" (subscribe scenes, web-view domains, server clock, theme from contracts), the splash
link, and `apps/web` unit-test timeouts under load.

## Done

1. Subscribe scenes: `templatesByScene` is gone; `applyAppConfig` passes
   `config.subscribeScenes` to `setSubscribeTemplates`. `SubscribeScene` is the contract's
   `AppSubscribeScene` (type import). A stored copy without `subscribeScenes` (older build) is
   ignored, as before for missing fields.
2. Web-view domains: `applyAppConfig` calls `setWebviewDomains(config.webviewDomains)`, so
   `openExternalLink` opens the shop's 业务域名 in the web-view (it only allowed
   `mp.weixin.qq.com` before).
3. Server clock: `lib/server-clock.ts` keeps the offset. A 200 of `app/config` sets it from
   `serverTime` (never the stored copy's); `serverClockTransport` wraps the platform transport
   in `data/api.ts` and sets it from any `X-Server-Time` header, which covers the bodyless 304.
   A non-finite time is ignored. `serverNow()` is the helper; the kit's `Countdown` already
   reads it. The test fakes (`serveApi`, `taroFake.onRequest`) can now answer headers.
4. Theme from contracts: `theme/{color,derive}.ts` re-export `@shop/contracts/system/theme`
   (kept as files so imports do not move); `derive.test.ts` deleted (the tests live in
   contracts); `@shop/contracts/system/theme` added to `CONTRACTS_RUNTIME` in the mini's eslint
   config; `theme/store.ts` derives with `themeInputOf(appearance.theme)`, so `accentColor`
   now reaches `--color-accent` (new `theme/store.test.ts`). The weapp bundle stays zod-free
   (size report ok, no `zod` in any main-package file). Main package 490.2 KB before items 1–4
   → 490.5 KB after 1–3 → 490.6 KB after 4 (+0.1 KB for the theme switch, +0.4 KB in all).
5. Splash link: there is no splash overlay on `storefront/mini` yet (stream B builds it), so
   nothing to fix. Added `openLinkTarget(link)` in `platform/link.ts` (exported from
   `@/platform`): catalogue kinds → `navigate(linkTargetRoute(link))`, `webview` →
   `openExternalLink` (业务域名 check, copy otherwise), `miniprogram` →
   `navigateToMiniProgram` (a cancel is silent, a failure toasts), `null` → nothing.
   `@shop/contracts/decor/link-route` (types-only imports) joins `CONTRACTS_RUNTIME`. The splash
   overlay and every DIY block's `onLink` should call it.
6. `apps/web` unit timeouts under load: the `unit` project's `testTimeout` 20 s → 120 s, plus
   `hookTimeout` 120 s (vitest.config.ts). Least invasive: the timeout is a hang detector,
   and the load comes from outside the suite (turbo's sibling tasks, other executors), so a
   worker cap would not help — web already runs 4 workers on 32 CPUs, and fewer would only
   slow an idle run. Idle, the slowest test is 2.4 s (product editor) and the project takes
   ~43 s. Reproduced by pinning the three named suites (diy panels, product editor, groupbuy
   activities) to one core beside 24 busy loops: at 20 s, 5 then 4 of 313 tests timed out;
   at 120 s, 313/313 pass (~6 min wall).

Final checklist (2026-09-24): `pnpm turbo run gen typecheck lint test:unit build` (45/45; mini
168 tests, web 857; weapp main 490.6 KB, total 567.5 KB, size report ok, zod-free),
`pnpm --filter @shop/e2e-storefront test:mini` (1 passed), `pnpm exec prettier --check .`,
`pnpm guards` (15 checks, 0 failures) — all pass.

## Notes for streams B–E

- Links: call `openLinkTarget(link)` from `@/platform` for any `LinkTarget | null` (splash
  overlay, DIY blocks' `onLink`); do not switch on `link.kind` in pages.
- Deadlines: read `serverNow()` from `@/lib/server-clock`, never `Date.now()`.
- Subscribe: `subscribe(scene)` with an `AppSubscribeScene`; the ids come from `app/config`.
- Theme: import from `@/theme/derive` (or `@shop/contracts/system/theme`); the accent colour
  is `--color-accent` / `theme.accent`.
- Tests: `serveApi` replies may carry `headers`.

## In progress

- Nothing. Ready for the coordinator.
