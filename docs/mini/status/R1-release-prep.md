# R1 — release prep: status

Branch `storefront/mini-R1-release-prep`, from `storefront/mini` (`f0a0b50`). Done; nothing in progress.

## Done

- **`api-compat` guard** (the 16th check), `3b25448`.
  - Check `guards/src/checks/api-compat.ts`, diff `guards/src/lib/api-compat.ts`, unit tests
    `guards/src/lib/api-compat.test.ts` (20 cases).
  - Baseline `guards/baselines/storefront-api.json`: 185 operations, `"release": null`. It is
    prettier-ignored.
  - Refresh command `pnpm --filter @shop/guards api-compat:refresh --release <x.y.z> | --unreleased`
    (`guards/scripts/api-compat-refresh.ts`). It regenerates the OpenAPI document, prints what it
    forgives and refuses `--unreleased` once a release is recorded.
  - Report-only: `ENFORCED = false` at the top of the check. Documented in `guards/README.md` and in
    `docs/mini/cutover.md` §5.
  - Breaking changes:
    - responses: a removed path or method; a field removed, made optional or made nullable; an enum
      value or union variant removed; a type changed;
    - requests: a field or parameter made required (new required ones included), removed, or
      narrowed (enum, null, type, length, bound, pattern, format).
  - New response enum values and new variants are notes. Unions are matched by tag. A renamed path
    parameter is the same URL.
- **Landing page at `/`**, `defc8b3`.
  - `apps/web/app/page.tsx` renders `apps/web/src/landing/landing-page.tsx`, fed by
    `apps/web/src/server/landing.ts`. It replaces the old origin-only 「商城服务 / 管理后台在 /admin」
    page.
  - Content: the shop name (站点设置 → 商城名称) and the home 小程序码 via `shareMiniCodeUrl`, with the
    line 「请使用微信扫码打开」.
  - Text fallback 「请在微信中搜索「<小程序名称>」小程序」: shown when the mini-program is off or the
    AppID/AppSecret is missing, or when anything is down.
  - Footer: the ICP and 公安备案 numbers from the site settings. A link is used only if it is http(s).
  - The code URL is cached in Redis for a day, keyed per `codeEnvVersion`, with a single-flight lock
    and a 10-minute backoff after a failure. An anonymous visitor therefore causes at most one WeChat
    call per 10 minutes.
  - Unit tests: `apps/web/src/server/landing.test.ts` and `apps/web/src/landing/landing-page.test.tsx`
    (10 cases).
  - **Not wired into the edge**: `docker/` and `deploy/` are untouched.
- **`docs/mini/cutover.md`**:
  - §2.9: the CI H5 steps are dropped rather than repointed.
  - §2.10 is rewritten with the exact `nginx.conf` diff, the Dockerfile/dockerignore changes and the
    drill check change.
  - §3.2 gets a new item: refresh the baseline on publish day.
  - New §5: the guard, its switch and when to refresh.

## In progress

Nothing.

## Pending

Nothing in scope. The edge wiring, the Dockerfile and the drill changes are cutover work (release B)
and are written down in cutover.md §2.10.

> Note (2026-09-24, L3): the A/B/C release split was dropped; the cutover is one release and
> cutover.md §2.10 is part of it. The `ENFORCED` switch stays `false` at the first release (HANDOFF §6
> item 7).

## Page-form changes

None in the mini-program. `/` on the web container changed: it now shows the shopper landing page
instead of 「管理后台在 /admin」 (the admin is still at `/admin`).

## Backend gaps

None.

## Open questions

- Response enum additions are notes, not failures, as the brief says. An old client that switches
  on a status it does not know may still mis-render. Should they fail once enforced?
- Request fields that are removed count as breaking, although the brief does not list them. The old
  client still sends the field and the server silently drops it.
- The landing page inherits the root layout's `robots: noindex`. Should `/` be indexable?
- No screenshot was taken: this sandbox has no browser, and the machine-load rule forbids `next dev`
  and builds. The markup was checked with `renderToStaticMarkup` only.

## Tests for the orchestrator to run

- Nothing new at the int/e2e level. The unit tests above are already run.
- After merging H6 (optional `bindToken` on `auth.passwordLogin`, which passes the guard) or any other
  `/api/v1` change: `pnpm --filter @shop/guards api-compat:refresh --unreleased`, then commit the
  baseline.
- Optional smoke test with a running stack: `curl -s http://127.0.0.1:3000/` on `web` should show the
  shop name and the fallback text.
