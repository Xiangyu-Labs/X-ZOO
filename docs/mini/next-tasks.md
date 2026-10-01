# Next tasks (done 2026-09-24)

These five tasks were re-dispatched on 2026-09-24, finished, and merged into `storefront/mini`.
Their results are in `docs/mini/status/<task>.md`; what is left over is in `docs/mini/HANDOFF.md`
§4 and §6. The briefs below are kept for reference only. Do not dispatch them again.

## K1-security: security review before cutover

Review `git diff master...storefront/mini`: `apps/web/app`, `packages/core`,
`packages/contracts`, `apps/mini`, `packages/storefront-blocks`, `packages/api-client` and
`apps/web/src/admin/decor`. `master` equals production.

Look for:

- **Authz / IDOR** on every new or changed `/api/v1` and `/admin-api` route. This covers invoice
  titles, reviews, `orders/:id/wechat-receipt`, addresses and coupon claim. Every admin route must
  declare its `permission`.
- **Decor preview tokens:** hashed, TTL, scoped to a single page.
- **The message-push webhook** `/api/v1/webhooks/wechat-mini`: signature and AES verification,
  replay, and what an unauthenticated caller can trigger.
- **`kindMeta` at checkout:** check that ORDER-009 is complete for presale too, and that the
  client can never choose the price.
- **Auth:**
  - silent login and renewal;
  - bind tokens;
  - password login;
  - tokens in logs;
  - the `X-Client-*` headers must never be trusted for anything security-relevant.
- **Content security bypass:** an edit route, another field, or a failed WeChat call. Is it
  fail-open or fail-closed, and is that documented?
- **Decor rich-text sanitizer** (DECOR-017): XSS in the admin canvas and in H5.
- **`LinkTarget` web-view and miniprogram targets:** restricted to verified domains.
- **The cached public layer** never carries per-shopper data (DECOR-015).
- **SSRF:** every server-side fetch goes through `core/storage/safe-fetch.ts`.
- **Uploads and generated media:**
  - avatar and image upload limits and types;
  - mini-code scene encoding;
  - posters.
- **Secrets:** none in responses, logs, examples, fixtures or the mini bundle.
- **Rate limits:** SMS, login, coupon claim.

How to report and fix:

- For each finding give its severity, `file:line`, the exploit, and whether it also exists on
  `master`. Put anything exploitable on production first, marked **PRODUCTION**.
- Fix small, local defects, each with a regression test that carries the rule ID.
- Write up anything large, or anything that touches core state machines, instead of fixing it.

## H6-auth-bind: password login links the mini openid

Today `auth.passwordLogin` takes no `bindToken`. After a password-session expires, `wx.login`
renewal lands on phone-required, or on another account that holds the openid. See
`docs/mini/auth.md` 「密码登录」 and `docs/mini/status/J3-auth-e2e.md`.

1. **Backend.** Add an optional `bindToken` exactly the way `auth.smsLogin` and
   `auth.miniPhoneLogin` take theirs.
   - Link through the same existing function, after the password check succeeds.
   - The conflict case is the same as the SMS path.
   - Password verification, lockout and session issuance are unchanged.
   - The contract change is additive, with an example.
   - Add int tests with an AUTH-* ID.
2. **Client.** In `apps/mini/src/session/session.ts`, `signInWithPassword` passes the pending
   bindToken, with a unit test.
3. **E2E.** Extend the SMOKE-004 spec in `e2e/storefront/specs-mini/login.spec.ts`: after a
   password login, a fresh `wx.login` renewal returns the same account.
4. **Docs.** Update `auth.md` and remove the gap from `e2e-coverage.md` §4.
5. **Privacy refusal copy.** `apps/mini/src/session/login-card.tsx` and
   `apps/mini/src/packages/account/phone` should use `isPrivacyRefusal` and a Chinese message,
   not WeChat's English error.

## K2-size-perf: mini-program size and runtime performance

Budgets: main package ≤ 1.5 MB, each subpackage ≤ 2 MB, total ≤ 8 MB. Last measured: main about
656 KB, total about 1 MB.

1. **Breakdown.** Break down the production weapp main package. Confirm there is:
   - no zod;
   - no `eval` or `new Function`;
   - no admin routes;
   - no demo subpackage;
   - no source maps;
   - no test fixtures.
2. **Package layout.**
   - Only the 4 tab pages, product detail, login and privacy belong in the main package.
   - Import NutUI per component.
   - Code that only subpackages use stays out of the main package.
   - Keep icons small.
3. **Runtime.**
   - Round trips before the home page's first screen.
   - `setData` size for long lists.
   - Image `lazyLoad` and thumbnails.
   - Timers cleared on hide.
   - `useDidShow` refetch storms.
4. **Budgets.** The build fails when over budget. Record the new baseline.

Anything that would change what a shopper sees is written up, not changed.

## K3-client-review: mini client correctness review

Look for defects that only show where pieces meet:

- **Cache invalidation and badges** after pay, cancel, receipt, refund, review, claim, address
  and cart changes.
- **Money:** no float maths.
- **Double submission and idempotency keys.**
- **Navigation:**
  - the route catalogue is used everywhere;
  - the page stack stays at 10 or fewer;
  - `redirectTo` after create and pay;
  - `switchTab` for tab pages.
- **Loading, empty and error states,** including a retry button.
- **Timers and listeners** are cleaned up.
- **Countdowns** use `serverNow()`.
- **Login gates** return to the page the shopper came from.
- **Guest browsing** works.
- **Copy** is consistent across pages.

Fix local defects with tests, and record 旧 → 新 for anything a shopper sees differently.

Ownership: stay out of `session/`, `packages/account/phone` (H6) and the build config (K2).

## R1-release-prep: storefront API compatibility guard and landing page

1. **Compatibility guard.** A new guard compares the storefront part of the generated OpenAPI
   (`/api/v1/**` only) with a committed baseline.
   - These are breaking and must fail:
     - a path or method removed;
     - a response field removed, or made optional or nullable;
     - a request field made required or narrowed;
     - a response enum value removed.
   - Additions pass.
   - Include a refresh command, run only when a mini version is released.
   - Unit-test the diff logic.
   - The guard is **report-only** until the first release flips it. Document where the switch
     is in `docs/mini/cutover.md`.
2. **Landing page for `/`.** Served by `apps/web` and **not yet wired into the edge**. Write the
   exact edge change into `cutover.md`.
   - Content: the shop name, the 小程序码, and "scan in WeChat".
   - Style: restrained, with no product names or images; light and dark; mobile first.
   - When WeChat is not configured, show a text fallback.
   - Add a unit test.
   - Don't touch `deploy/`.
