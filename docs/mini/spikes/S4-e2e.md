# Spike S4: end-to-end tests for the mini-program

**Question.** Can the mini-program's journeys run in CI, in a browser, against the real server, without WeChat? And can that happen without any test code reaching the WeChat package?

**Answer.** Yes, with one limit. The H5 build of `apps/mini` has a third flavour, "模拟小程序" (mp emulation). It behaves towards the server exactly like the mini-program:

- It says `X-Client-Platform: wechat-mini`.
- It signs in with `wx.login` codes.
- It binds a phone number with `getPhoneNumber` codes.
- It pays through `requestPayment`.

Wherever a phone would ask WeChat, the page asks the e2e harness instead. The harness answers through the fakes in `@shop/testing`.

The first journey passes end to end in **1.2 s**, and **~9 s** including the stack (**~21 s** when the emulation build has to run first): a new WeChat user signs in, binds a phone, buys, pays, and the order reads `paid`. The WeChat build carries none of it, and `scripts/size-report.mjs` now fails the build if it ever does.

The limit is that this proves our code and our server, not WeChat's client. The [real-device checklist](#real-device-checklist) below is what only a phone can prove.

## Emulation design

### One seam, three builds

`apps/mini/src/platform/types.ts` defines `MiniPlatform`, the WeChat capabilities the storefront uses:

- `login()`
- `PhoneNumberButton`
- `requestPayment()`
- `requestSubscribe()` and `chooseAddress()`: stubbed with `TODO(stream A)`, because this spike does not need them.
- `api`: the base URL, transport and `X-Client-Platform` for `@shop/api-client`.

Pages and features only ever import `platform` from `@/platform`.

| Build                              | Module resolved for `./runtime` | Implementation                                                                                                                    |
| ---------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `build:weapp` (the product)        | `runtime.tsx`                   | `Taro.login`, `<Button openType="getPhoneNumber">`, `Taro.requestPayment`, `taroTransport(Taro.request)` to `TARO_APP_API_ORIGIN` |
| `build:h5` (DIY preview)           | `runtime.h5.tsx`                | `h5-preview.tsx`: same-origin `fetch` as `h5`. Sign-in and payment say "not available".                                           |
| `build:h5:mp-emulation` (e2e only) | `runtime.h5.tsx`                | `h5-mp-emulation.tsx`: same-origin `fetch` as `wechat-mini`, WeChat answered by the harness                                       |

The split is decided when the bundle is built, never at run time:

- **weapp vs H5.** Taro's `MultiPlatformPlugin` resolves `./runtime` to `runtime.h5.tsx` when `TARO_ENV=h5`. This only works for relative imports, so `platform/index.ts` must keep `from './runtime'` (commented there). The weapp module graph never contains the H5 files.
- **preview vs emulation.** `config/index.ts` defines `process.env.TARO_APP_PLATFORM_EMULATION` as a constant (`''` or `'mp'`). The branch in `runtime.h5.tsx` is dead code in the plain H5 build, and webpack drops it (`grep __e2e dist/h5` finds nothing).
- **Guard.** `config/index.ts` throws if the flag is set for anything but an H5 build. The emulation build also gets its own output directory (`dist/h5-mp-emulation`) and bundle-stats file, so it can never overwrite `dist/h5` or `dist/weapp`.
- **Scan.** `scripts/size-report.mjs` (run by `build`) fails if `dist/weapp` contains any of `/__e2e/`, `__shop_mp_emulation__`, `h5-mp-emulation` or `h5-preview`, or if the weapp module list includes `platform/runtime.h5`, `h5-mp-emulation` or `h5-preview`. I checked that the scan catches a planted marker (a copy of `dist/weapp` with `/__e2e/mini/login-code` appended fails with `contains test-only "/__e2e/"`).

### What the harness answers

The page calls three same-origin endpoints. The e2e edge (`e2e/storefront/src/edge.ts`) forwards them to the gateway control plane (`src/gateway-control.ts`), and only in mini mode. In production these paths are a 404 like any other.

| Page calls (`h5-mp-emulation.tsx`)                       | Stands in for                        | Harness does                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /__e2e/mini/login-code {openid, unionid?}`         | `wx.login()`                         | Mints a random code and teaches it to the fake `api.weixin.qq.com` (`setMiniCode`). The server redeems it via its real `jscode2session` call.                                                                      |
| `POST /__e2e/mini/phone-code {phone}`                    | tap on `open-type="getPhoneNumber"`  | Mints a code and teaches it to `getuserphonenumber` (`setPhoneCode`).                                                                                                                                              |
| `POST /__e2e/mini/request-payment {outTradeNo, package}` | the shopper confirming the pay sheet | Checks that the server placed that transaction on the fake WeChat Pay gateway and that the page holds a `prepay_id=` package. Then `markPaid` and a signed notification to the real `/api/v1/webhooks/wechat-pay`. |

**Which WeChat user is holding the phone is test data.** The spec writes `localStorage['__shop_mp_emulation__'] = {openid, unionid?, phone, payment?}` before the app starts (`e2e/storefront/src/mini.ts`: `wechatUser`, `holdPhone`). `payment: 'cancel' | 'fail'` plays the shopper closing the sheet, or WeChat failing it. Without that key, the emulation invents a user and keeps it, so a developer can click through by hand.

**Stack wiring in mini mode** (`scripts/serve.ts`, `SHOP_E2E_CLIENT=mini`):

- `startFakeOaServer()` runs as the fake `api.weixin.qq.com`.
- The seed writes the `wechat` group's `miniAppSecret` and `apiBaseUrl` to point at it, and turns on the `wechat-mini` group (`enabled: true`). `requirePhoneForWechat` stays at its default, `true`, so a new shopper gets `phone-required`.
- The fake WeChat Pay gateway is started with `appId` = the fake mini app id. `payment.start` charges `wechat_mini` to `wechat.miniAppId`, and the fake gateway rejects any other appid, so this has to match.
- Mini mode has its own ports (`CHECKOUT_ID` is derived from the checkout path + `:mini`), its own stack file (`shop-e2e-storefront-mini-<id>.json`) and its own database (`shop_e2e_storefront_mini`). A uniapp stack and a mini stack can be up at once in one checkout.

### App code this spike added (deliberately plain)

- **Session** (`features/session/session.ts`):
  - Silent `wx.login` on `useLaunch`, run once even when called concurrently.
  - A stored token is reused.
  - `phone-required` parks the `bindToken`, and `LoginCard` shows 手机号快速登录.
  - A `getPhoneNumber` code that WeChat refuses keeps the `bindToken` (AUTH-007).
  - `AUTH_WECHAT_BIND_EXPIRED` starts over with a fresh `wx.login`.
  - A 401 drops the token and signs in again.
  - This follows `docs/mini/auth.md`, which H1 merged mid-spike, except for the one gap listed under [Deviations](#deviations-and-open-points).
- **Pages**, at their `docs/mini/pages.md` paths:
  - `pages/product/index?id=`
  - `packages/order/checkout/index`: the draft is held in memory, using `checkout/preview` with the default address, then `order.create` with an idempotency key and `expectedPayableAmount`.
  - `packages/order/cashier/index?orderId=`: `payment.start {channel: 'wechat_mini'}` → `platform.requestPayment`. A cancel stays on the page; anything else goes to the result page with `redirectTo`, per C06.
  - `packages/order/pay-result/index?orderId=&outTradeNo=`: polls `payment.status` every second for up to 60 s.
- **API client** (`data/api.ts`): one `createApiClient` fed by `platform.api`. Auth hooks are plugged in by the session module, so neither module imports the other.

## What is and isn't covered, compared with a real mini-program

**Covered.** Same code as production, exercised end to end:

- The storefront's React pages, the session state machine, `@shop/api-client` (call, errors, 401 hook) and TanStack Query, compiled by Taro for H5 from the same sources as weapp.
- Server side of mini sign-in:
  - `POST /auth/sessions/wechat-mini` → a real HTTP `jscode2session` call with the mini appid and secret;
  - `phone-required` → `POST /auth/sessions/wechat-mini/phone` → a real `getuserphonenumber` call;
  - the account created with `register_source = wechat_mini`, a `wechat_identities` row `(mini, openid)`, and a `user_sessions.platform = wechat-mini`.

  The spec asserts all three rows.

- Server side of mini payment:
  - `payment.start` with `wechat_mini` → a JSAPI prepay on the gateway with the mini appid and the payer's openid → a signed JSAPI parameter set for the page;
  - the signed notification → the webhook → the order becomes `paid`;
  - `payment.status` polling sees it.

  The spec asserts the attempt's `channel`/`appId` and the order via the shopper's own `GET /api/v1/orders/:id`.

- Page health: the spec fails on any console error or failed request (`consoleErrors`, `failedRequests`).

**Covered only by unit tests** (`apps/mini`, Vitest with the fake Taro runtime):

- The weapp implementation: `Taro.login`, the `getPhoneNumber` event mapping (code / deny / fail) and the `requestPayment` outcome mapping (ok / `fail cancel` / other).
- `taroTransport(Taro.request)` and `X-Client-Platform` through it. The session tests run on the weapp transport.
- The cashier's cancel and already-paid paths.

**Not covered.** Emulation cannot see these:

- Taro's **weapp runtime and native components**. The e2e suite renders Taro's H5 web components (`taro-button-core`…), not WXML. Layout, `openType` buttons and native event shapes are only checked on a device.
- **WeChat's own behaviour**:
  - real code expiry and single use (the fake does not reject a reused code; the emulation always mints fresh ones);
  - the phone-number consent sheet and its privacy gate;
  - the pay sheet itself;
  - how WeChat validates `paySign` against the merchant's key and the AppID–MchID binding;
  - notification delivery from WeChat's servers to a public HTTPS URL.
- **`wx.request` limits**: the 合法域名 whitelist, TLS, 10 concurrent requests, no `PATCH` (the transport already refuses it), no cookies.
- **Payment by `prepay_id`.** The emulation also sends `outTradeNo`, because the fake gateway does not map a `prepay_id` back to its transaction. On a phone, `requestPayment` gets only the `package`.
- Subscribe messages, `chooseAddress`, share and scene values. None is built yet (stream A).
- iOS JavaScriptCore. The ES2018 gate in `size-report` is the proxy for it.

### Real-device checklist

Run these on one iPhone and one Android phone, with a real AppID and a test merchant, before each release that touches sign-in or payment.

1. **Configuration**
   - `TARO_APP_API_ORIGIN` is the shop's https origin (in `.env.production.local`, gitignored) and is listed as a request 合法域名. A wrong origin fails every request with `request:fail url not in domain list`.
2. **Cold start as a new WeChat user**
   - Silent sign-in lands on `phone-required`, and the product page shows 手机号快速登录.
3. **Phone number button**
   - The consent sheet appears (the privacy agreement is configured, and `__usePrivacyCheck__` is on).
   - Allow → signed in.
   - Deny → a toast, and the button still works.
   - Account needs: an enterprise account with 手机号快速验证 enabled. It is billed per call.
4. **Hot start**
   - No sign-in call when a token is stored.
5. **Session renewal**
   - Revoke the session in the admin (退出所有设备) → the next request 401s → silent renewal with no visible prompt.
6. **Buy now → pay**
   - The pay sheet shows the right amount and the right merchant name.
   - Pay → 支付成功 within a few seconds. This needs the notify URL reachable from WeChat.
7. **Cancel the sheet**
   - The cashier says 已取消支付, the order stays 待支付, and paying again works (same `outTradeNo`).
8. **Kill the app mid-payment**
   - After paying but before returning, kill the app. On relaunch, the order shows paid.
9. **Returning from 支付结果**
   - Back does not land on the cashier (`redirectTo`).
10. **Package size**
    - Upload through DevTools and check the sizes match `size-report` (main 380.7 KB on this branch).
    - Check that 代码质量 reports no ES6+ issues on iOS 12 if it is still supported.

## How to run it locally

```bash
# once per machine
pnpm --filter @shop/e2e-storefront exec playwright install chromium

# the mini-program journeys (SHOP_E2E_CLIENT=mini)
pnpm --filter @shop/e2e-storefront test:mini

# the uni-app journeys, unchanged
pnpm --filter @shop/e2e-storefront test

# keep a mini stack warm and rerun specs against it
SHOP_E2E_CLIENT=mini pnpm --filter @shop/e2e-storefront exec tsx scripts/serve.ts
SHOP_E2E_CLIENT=mini SHOP_E2E_REUSE=1 pnpm --filter @shop/e2e-storefront test:mini

# click through by hand: open the edge URL the serve script prints,
# e.g. http://127.0.0.1:<port>/#/pages/product/index?id=<postageProductId>
```

- The serve script rebuilds `apps/mini/dist/h5-mp-emulation` only when the mini sources, config, `api-client`, `contracts` or `storefront-blocks` changed.
- `next build` runs once per checkout. Pass `SHOP_E2E_BUILD=1` after changing `apps/web`, `packages/core` or the contracts: a stale `.next` silently serves the old server.
- The emulation build on its own: `pnpm --filter @shop/mini build:h5:mp-emulation`. The weapp build and gate: `pnpm --filter @shop/mini build` (weapp, H5 preview, size report and test-only scan).

## Numbers

Measured on this machine (WSL2), on the branch after merging `storefront/mini` (H1 + S3):

| What                                                                           | Time / size                                                                                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `build:h5:mp-emulation`                                                        | 7.7 s (webpack 7.5 s); `app` entry 629 KiB                                                                                      |
| `build:weapp`                                                                  | 11.4 s                                                                                                                          |
| Mini stack ready (containers, seed, `next start`, worker, edge; `.next` built) | 4.2–5.0 s; 14.3 s when the emulation build runs too                                                                             |
| The mini journey                                                               | 1.2–1.4 s                                                                                                                       |
| `test:mini` wall clock                                                         | 9.0 s (two consecutive runs); 20.6 s on the first run, which built the H5 bundle                                                |
| `test` (uni-app, 34 specs) before S4                                           | 2 min 40 s (34 passed)                                                                                                          |
| `test` (uni-app) after S4, with `SHOP_E2E_BUILD=1`                             | 2 min 02 s (34 passed; stack 51.3 s including a full `next build`)                                                              |
| weapp main package                                                             | 342.6 KB (S1) → 373.0 KB with S4 (+30 KB: api-client and its route table, session, platform, pages) → 380.7 KB after merging S3 |
| `order` sub-package                                                            | 7.0 KB (three plain pages)                                                                                                      |

## Recommendations for the I streams

### CI job shape

- **Separate job, `e2e-storefront-mini`**, next to the uni-app job and not a step inside it. One stack serves one client, and the mini job is short (~10–20 s once `.next` exists) where the uni-app one takes minutes.
- Both jobs need Docker (Testcontainers) and Playwright Chromium. Share the `apps/web/.next` build between them (a build job that uploads `.next`, or a cache keyed on `apps/web` + `packages/{core,db,contracts}`), otherwise each pays for `next build`.
- **Steps:**
  1. `pnpm install --frozen-lockfile`
  2. `pnpm gen`
  3. restore `.next`
  4. `pnpm --filter @shop/e2e-storefront test:mini`
  5. on failure, upload `e2e/storefront/playwright-report` and `test-results` (traces are kept on failure)
- **Gate the WeChat package in the same pipeline:** `pnpm --filter @shop/mini build`. Its size report is what guarantees the emulation stays out of `dist/weapp`. Run it on every PR that touches `apps/mini` or anything it compiles from source.
- Keep `workers: 1` for now. Mini specs are independent by construction (a fresh openid per test), so a later move to `fullyParallel` with more workers only needs the stack's seed data to stay read-only.

### Page objects

- Keep them thin: one module per page under `e2e/storefront/src/mini/pages/` (e.g. `product.ts`, `cashier.ts`), exposing intent (`buyNow()`, `payWithWechat()`) and exact visible text. Taro H5 components are custom elements (`taro-button-core`), so `getByRole('button')` does not find them. `getByText(…, { exact: true })` does, and it is what a shopper sees.
- Open pages by route with `miniRoute('packages/order/cashier/index', { orderId })` (Taro H5 uses the hash router), and assert transitions with `toHaveURL`, since 收银台/支付结果 use `redirectTo`.
- Once pages have real design, add stable hooks on the Taro side. `id` is carried through on both platforms. Whether `data-testid` survives the weapp and H5 templates is unverified; check it before standardising.

### Fixture patterns

- `wechatUser` (fresh openid and phone per test) makes every test a new shopper with no database reset. For a **returning shopper**, reuse one `EmulatedWechatUser` across two pages (`holdPhone`): the second launch must sign in silently with no phone step.
- Unhappy paths are data, not code: `newWechatUser({ payment: 'cancel' })` or `{ payment: 'fail' }`. Add `phone: 'deny'`-style switches the same way when stream A needs them (in `h5-mp-emulation.tsx` and `src/mini.ts`, whose storage key must match).
- **Arrange** what the journey is not about through core services on the shared stack (`shop.ctx.as(userActor(id))`, as the address is here). **Read back** through the shopper's own API (`sessionToken(page)` gives the bearer token), and through `shop.db` only for what no API shows (sessions, identities, payment attempts).
- When `chooseAddress` and subscribe messages land, give the emulation an answer for each from the same `localStorage` record, and add a harness route only if the server has to be told something (as with payment).

## Deviations and open points

- **Checkout page added.** The brief put the preview → `order.create` on the product page. `pages.md` has a `checkout` page in the `order` sub-package, so 立即购买 goes there, and the product page only sets the in-memory draft.
- **`pnpm-lock.yaml`** changed by the one line that adds `@shop/api-client` to `apps/mini`.
- **`babel.config.js`** now forces `transform-optional-catch-binding`. `@shop/api-client` uses `catch {` (ES2019). iOS 12 parses it, but S1's ES2018 gate does not, and the gate failed the first weapp build that included the client.
- **The e2e `StackInfo` gained `client`, `wechatMiniAppId` and `fixtures.division`**, and `seed.ts` exports `userActor` and takes an optional `miniProgram` block. The uni-app journeys ignore all of these.
- **The 401 "replay the request once" step from `docs/mini/auth.md` is not implemented.** The client renews the session. A query then retries through TanStack's `retry: 1` or when its `enabled: signedIn` flips back on, but a mutation that 401s is not replayed. This is left to stream A (the session and api-client hook).
- **`@shop/testing` limits met (not changed; owned by H):**
  - The fake WeChat Pay gateway does not record `prepay_id → outTradeNo`, so the emulation also passes `outTradeNo`. With that mapping, `request-payment` could take only the `package`, exactly like `wx.requestPayment`.
  - The fake `api.weixin.qq.com` accepts a code more than once. Real WeChat codes are single-use, so a client bug that reuses one would pass here.
- **No backend gaps.** Every route and config the journey needs already exists.
