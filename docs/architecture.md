# Architecture

How the shop is put together. [conventions.md](conventions.md) has the rules for writing code in
it; [invariants.md](invariants.md) lists the business rules and the tests that prove each one.

## Processes

```
                 Traefik (TLS, host routing)
                           │
                     edge (nginx)
        ┌──────────────────┼──────────────────────┐
   /, /admin, /admin-api, /api    /uploads/ (read-only volume)
                           │
                     web (Next.js)  ──────┐
                           │              │ enqueue, pub/sub
                    PostgreSQL 17     Redis 7
                           │              │
                     worker (BullMQ) ─────┘
```

| Process   | Source                      | Job                                                                                                  |
| --------- | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `edge`    | `docker/edge/`              | Serves `/uploads/`, proxies the landing page and the application paths to `web`, answers `/healthz`. |
| `web`     | `apps/web`                  | Every HTTP endpoint and the admin UI. Holds no state of its own.                                     |
| `worker`  | `apps/worker`               | Scheduled and on-demand jobs, and the dispatcher of the effects ledger.                              |
| `migrate` | `packages/db`, worker image | A one-shot that `shop upgrade` runs to apply migrations (with the application stopped) and the seed. |

PostgreSQL holds all business state. Redis holds what may be rebuilt or lost with a bounded cost:
admin sessions, the config cache, rate-limit counters, the BullMQ queue, the worker heartbeat,
cached logistics answers and the pub/sub channel of the admin notification stream. It runs with
`noeviction` and AOF, because a silently evicted queue entry is a lost job.

The production topology, its health checks and its operation are in
[deploy/README.md](../deploy/README.md).

## Packages

```
packages/contracts  ← packages/core ← apps/web, apps/worker
        ↑                  ↑
   admin UI (apps/web)  packages/db
```

- **`@shop/contracts`**: the API, declared once. Depends on zod and nothing else in the repository.
- **`@shop/db`**: the Drizzle schema (`src/schema/<domain>.ts`), migrations
  (`migrations/*.sql`, applied ones never change), and the reference-data seed.
- **`@shop/core`**: the domain logic. Imports contracts and db; never Next.js, React or an app.
- **`@shop/testing`**: the Testcontainers harness, factories, `runConcurrently`, the fake WeChat,
  WeChat Pay, SMS and logistics gateways, and the mock server that answers every route with its
  first example.
- **`@shop/api-client`**: the typed `/api/v1` client the mini-program uses, over a transport each
  build supplies, with TanStack Query hooks and the zod-free route catalogue (`/routes`, written by
  `pnpm gen`). Imports contracts as types only.
- **`@shop/storefront-blocks`**: the decoration blocks, rendered by the mini-program and by the
  admin editor's canvas. Types-only contracts too.
- **`apps/web`** and **`apps/worker`**: thin shells that build a `Ctx` and call `core`.

ESLint enforces the arrows (see [conventions.md](conventions.md#import-boundaries-eslint-enforced)).

## Contracts

Every endpoint is a `defineRoute({...})` in `packages/contracts/src/<domain>/*.contract.ts`. The
shared shapes (`money`, `instant`, `id`, `pageQuery`, `paged`, `sortQuery`) are in
`src/_conventions/common.ts`, and `defineErrors` in `src/_conventions/errors.ts` declares a domain's
error codes with their HTTP status and Chinese message.

`pnpm gen` collects every contract into `src/routes.gen.ts` (`allRoutes`) and every error table
into `src/errors.gen.ts`, and writes `openapi.json` from them. Everything else reads those:

- the admin UI calls a route through `useRouteQuery(route, …)` and `useRouteMutation(route)`
  (`apps/web/src/admin/api/hooks.ts`), typed from the route's own schemas;
- the mock server in `@shop/testing` answers each route with its first example;
- the guards compare the route list with the App Router tree and the permission atoms, and the
  storefront part of `openapi.json` with the last released mini-program's (`api-compat`).

With `VALIDATE_RESPONSES=1` (on in development and in every test run) `handle()` checks each
response against its contract, so a service that drifts from the contract fails loudly.

## Request path

A route file names a contract and calls one service function:
`export const GET = handle(couponAdminList, (ctx, { query }) => coupon.adminList(ctx, query))`.
`handle()` in `apps/web/src/server/handle.ts` does everything common to every endpoint:

```
parse → authenticate → CSRF → authorise → build Ctx → call → validate response → serialise → log → audit
```

- **Admin** sessions are an httpOnly cookie naming a Redis session that carries the admin's id,
  permission atoms, super flag and `passwordVersion`. Changing a password or a role revokes the
  sessions it affects.
- **Storefront** sessions are opaque Bearer tokens; `user_sessions` stores only their hash. The
  client names its platform (H5, mini-program, official account) in `X-Client-Platform`.
- **Authorisation** compares the route's `permission` with the session's atoms. A super admin
  passes every check; nothing in the product grants `is_super`.
- A `DomainError` becomes its declared status and message. Anything else becomes a 500 `INTERNAL`
  whose details go to the log and not to the client.
- Admin writes are recorded in the audit log, with secrets redacted.

## Kernel

`packages/core/src/kernel/` holds what every domain uses:

| Piece                           | File                               | What it gives                                                                                                                                                             |
| ------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ctx`                           | `context.ts`                       | Everything a service may reach: db, redis, clock, config, logger, queue, storage, actor, platform, request id. Built per request by `handle()` and per job by the worker. |
| `withTx`, `lockRow`, `lockRows` | `tx.ts`                            | Transactions, row locks, and lock ordering by ascending id.                                                                                                               |
| `Money`                         | `money.ts`                         | Integer fen arithmetic and allocation; `"12.00"` only at the API edge.                                                                                                    |
| `Clock`                         | `clock.ts`                         | The only source of "now" in domain code, so tests control time.                                                                                                           |
| Config registry                 | `config-registry.ts`               | `defineConfigGroup` and `ctx.config.get(group)`; values in `config_values`, cached in Redis.                                                                              |
| `JobQueue`                      | `queue.ts`, `queue-bullmq.ts`      | The queue port; `memoryQueue()` in unit tests, BullMQ in the apps.                                                                                                        |
| `Storage`                       | `storage.ts`                       | The storage port and its local-disk driver.                                                                                                                               |
| Rate limits                     | `rate-limit.ts`                    | Fixed-window and token-bucket limits in one Lua round-trip, keyed by subject (account, phone, user), never by IP.                                                         |
| Errors, ids, logger             | `errors.ts`, `ids.ts`, `logger.ts` | `DomainError`, id parsing, the structured logger with redaction.                                                                                                          |

## Domains

One directory per domain under `packages/core/src/`, each with its schema in
`packages/db/src/schema/` and its contracts in `packages/contracts/src/`:

| Domain                | Holds                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `auth`                | Admins, roles, permission atoms, admin and storefront sessions, captcha, the audit log.          |
| `user`                | Shoppers, addresses, labels, groups, storefront sign-in.                                         |
| `catalog`             | Products, SKUs and stock, categories, labels, parameters, reviews, search, view counts.          |
| `cart`                | The cart.                                                                                        |
| `order`               | Orders, the order state machine, checkout pricing, invoices, fulfilment, the cross-domain ports. |
| `payment`             | Payment attempts, WeChat Pay callbacks, payment exceptions, reconciliation, capital flows.       |
| `refund`              | Refund requests, approval and execution.                                                         |
| `shipping`            | Freight templates, cities, express companies, logistics tracking.                                |
| `coupon`              | Coupon templates, claiming, user coupons, allocation at checkout.                                |
| `groupbuy`, `presale` | The two promotion order kinds.                                                                   |
| `decor`               | Page decoration v2: documents, revisions, the page resolver, preview tokens.                     |
| `cms`                 | Articles and agreements.                                                                         |
| `notification`        | In-app notices, message templates, subscription messages, the live admin stream.                 |
| `wechat`, `wechat-oa` | The WeChat client and WeChat Pay v3; the official account's menus, replies, QR codes, media.     |
| `sms`                 | Verification codes and the SMS provider port.                                                    |
| `storage`             | Uploads, the asset library, scan-to-upload, safe remote fetch, the S3 driver.                    |
| `stats`               | The dashboard.                                                                                   |
| `system`              | Site settings and the config groups that belong to no single domain.                             |
| `effects`             | The post-commit side-effect ledger.                                                              |

A domain exposes itself through its `index.ts` and is installed once at bootstrap through
`@shop/core/domains` (`src/domains.gen.ts`); see
[conventions.md](conventions.md#where-a-domains-files-go).

### The order ports

Several domains act on an order without owning it. `packages/core/src/order/ports.ts` is the one
place they meet; it holds interfaces, types and registries, and no behaviour:

- `ORDER_STATUSES`, `ORDER_TRANSITIONS`, `canTransition` and `OrderStateMachine`: a transition is
  one conditional `UPDATE … WHERE status IN (…)` decided on the affected row count.
- `onOrderPaid`, `onOrderCancelled`, `onOrderRefunded`, `onOrderCompleted`: hook registries. Hooks
  run inside the caller's transaction, touch only the database, and are idempotent.
- `StockPort` (catalog): reserve at order creation, commit on payment, release on cancel or refund.
- `PaymentPort` (payment): `closeOrderPayments` outside the cancelling transaction, then
  `ensureNoOpenAttempts` under the order lock, answering `closed`, `paid` or `unknown`. An `unknown`
  refuses the cancel and keeps every reservation.
- `FreightPort` (shipping), `PricingContributor` (coupons and promotions) and `OrderKindHandler`
  (group buying and presale) plug into checkout.

Fakes for every port are in `@shop/testing`.

### The effects ledger

Anything that calls a third party (WeChat Pay, a refund, an SMS, a subscription message, a template
message) is not done inside the transaction. The domain writes a row in `effects` in the same
transaction as the state change; the worker's dispatcher claims due rows after commit and runs the
handler the domain registered in its `effects.ts`.

- Recording is exactly-once: `UNIQUE (scope, scope_id, event_type)`.
- Dispatch is at-least-once, under a lease, with retry and backoff. Handlers are idempotent.
- A row with no registered handler parks as `unknown` instead of being dropped.
- The admin console lists effects by status and can retry one.

### Configuration

A settings screen is a config group: one `defineConfigGroup` in a domain's `*.config.ts`, with a
zod schema in which every field has a default, and `ui` metadata (labels, sections, field kinds,
`visibleWhen`). Values live in `config_values (group, key, value jsonb)`. One `<ConfigGroupForm>`
renders every group; secrets travel to the browser as "is set" only. The groups are collected by
`pnpm gen` into `config-groups.gen.ts`.

### Permissions and menus

A permission atom is `<domain>:<resource>:<action>`, declared in the domain's `permissions.ts` and
named by the contracts that need it. Roles are sets of atoms. The admin menu is assembled from
`apps/web/src/admin/menu/*.menu.ts` (`defineMenu`); an entry shows only when the admin holds its
atom. `apps/web`'s `gen` step assembles the menu. The `permissions` guard checks that every atom a
route or menu entry names is declared, and that no declared atom goes unused.

## Third parties

Every third party is behind a port with a real driver and a fake in `@shop/testing`. The tests and
the e2e suites use the fakes only.

| Service                   | Where                                                     | Notes                                                                                                                  |
| ------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| WeChat Pay v3             | `core/src/wechat/wechat.pay.ts`, `core/src/payment/`      | JSAPI, mini-program and H5; signed callbacks; stale attempts reconciled by the worker; refunds via `refund`.           |
| WeChat (mini-program, OA) | `core/src/wechat/wechat.client.ts`, `core/src/wechat-oa/` | code2session, OA OAuth and JS-SDK, menus, media, template and subscription messages. Access tokens cached in Redis.    |
| SMS                       | `core/src/sms/` (`sms.port.ts`, `sms-aliyun.ts`)          | Aliyun SMS. `send` never throws: an outage is a retryable answer, not a 500. `SHOP_FAKE_SMS` selects the fake driver.  |
| Logistics tracking        | `core/src/shipping/shipping.logistics.port.ts`            | Aliyun market express API; the host is fixed in code, answers cached in Redis; a failure reads as `unknown`.           |
| Object storage            | `core/src/kernel/storage.ts`, `core/src/storage/s3.ts`    | Local disk (the `uploads` volume, served by the edge) or any S3-compatible service. The server always chooses the key. |
| Remote fetch              | `core/src/storage/safe-fetch.ts`                          | The only way to fetch a user-supplied URL: public addresses only, redirects re-checked, size and time capped.          |

## Worker

`apps/worker/src/main.ts` starts one process that runs every job. A job is a file
`apps/worker/src/jobs/<domain>.<verb>.ts` exporting `defineJob({...})`: a name, a payload schema, a
handler, and optionally concurrency, attempts and a `repeat` schedule; `pnpm gen` collects them into
`jobs.gen.ts`. The payload is validated before the handler runs, and a job that exhausts its
attempts lands in `failed_jobs`.

Scheduled jobs declare their own `repeat` (a cron pattern in Asia/Shanghai time, or an interval):
order auto-cancel, auto-receive and completion sweeps; payment reconciliation and exception-refund
rechecks; refund reconciliation; coupon claim-window and expiry sweeps; group-buy and presale
window sweeps; catalog auto-review, view-count folding and history pruning; orphaned-upload
cleanup; audit-log and session pruning; the effects dispatcher; the heartbeat.

The worker refreshes `worker:heartbeat` in Redis on an interval, with a TTL of four intervals; the
container health check reads that key. On SIGTERM it stops taking jobs and waits up to
`SHUTDOWN_TIMEOUT_MS` for the running ones.

## Admin UI

The admin is part of `apps/web`: pages under `app/admin/(shell)/<domain>/`, Ant Design 6 on React
19, all text in Simplified Chinese. Pages are built from the kit in `apps/web/src/admin/kit/`:

- `CrudTable`: a paged, sortable, filterable table bound to a list contract.
- `ZodForm`, `ModalForm`: forms typed from a contract's body schema.
- `ConfigGroupForm`: every settings screen.
- `AssetPicker`, `LinkPicker`, `SkuPicker`: choosers backed by providers the page supplies.
- field components: `MoneyInput`, `DateField`, `RichTextField`, `AssetField`, `LinkField`,
  `SortableListField` and more.
- `MoneyText`, `InstantText`, `StatusTag`, `DescriptionsCard`, `ConfirmButton`, `PageContainer`.

Data flows through `useRouteQuery` and `useRouteMutation`; `useCan()` from `src/admin/session`
hides what the admin's atoms do not allow. `/admin/dev/kit` renders every kit component, and
`apps/web/src/admin/kit/README.md` documents them. 店铺装修 (`src/admin/decor`) is the Puck
editor of decor v2 (see [The mini-program](#the-mini-program)). It takes its block schemas from
`@shop/contracts`, so the editor, the API and the client agree on each block's shape. The notification bell listens on
`/admin-api/notifications/stream`, a server-sent event stream fed by Redis pub/sub.

## The mini-program

`apps/mini`, the WeChat mini-program, is the one client of `/api/v1`. [docs/mini/](mini/README.md)
is its own documentation.

`apps/mini` is Taro 4 on React 18, in the pnpm workspace. It is built from
`@shop/api-client` (the typed `/api/v1` client over the build's transport, TanStack Query hooks,
and the zod-free route catalogue `@shop/api-client/routes`) and `@shop/storefront-blocks` (the
decoration blocks). Contracts reach it as types only; nothing in the package carries zod.

```
apps/mini/src/
  app.tsx, app.config.ts, app.pages.ts   launch sequence; pages, sub-packages, tab bar
  pages/            the main package: home, category, cart, me, product, login, agreement
  packages/         sub-packages: goods, order, aftersale, promo, account, content, page
  features/         page-sized pieces shared across pages (cart, checkout, decor, share…)
  platform/         the only code that calls WeChat (Taro.*, wx.*)
  session/          sign-in, renewal, sign-out
  app-config/       the shop's app config, cached and revalidated
  theme/            tokens derived from the config's appearance
  data/             the api-client instance, query client, uploads
  ui/               the component kit (our own; no third-party component library)
```

**The platform seam.** `src/platform/types.ts` declares one `MiniPlatform` interface
(navigation, sign-in codes, payment, storage, clipboard, the tab bar, the phone-number button…),
and the bundler picks its implementation per build, never at run time:

| Build                                   | Module           | Implementation                                               |
| --------------------------------------- | ---------------- | ------------------------------------------------------------ |
| `build:weapp` (what ships)              | `runtime.tsx`    | `Taro.login`, `Taro.requestPayment`…                         |
| `build:h5` (a browser preview)          | `runtime.h5.tsx` | `h5-preview.tsx`: no WeChat                                  |
| `build:h5:mp-emulation` (the e2e suite) | `runtime.h5.tsx` | `h5-mp-emulation.tsx`: WeChat answered by the fakes' gateway |

`scripts/size-report.mjs` fails the weapp build if an H5 implementation leaks into it, or if the
package exceeds its size budget.

**The session** (`src/session/`, [mini/auth.md](mini/auth.md)). At launch, a stored token is
used as it is; without one, `wx.login` → `POST /api/v1/auth/sessions/wechat-mini` signs a known
shopper in silently. A shopper the shop does not know yet (or one the shop requires a phone
for) gets a short-lived bind token, and the login page finishes it with 手机号快速登录
(`…/wechat-mini/phone`) or an SMS code (`…/wechat-oa/phone`), both of which bind the openid so the
next launch is silent. Browsing never needs a session; an action that does calls
`requireLogin()`. `renewing-transport.ts` wraps the build's transport: a 401 on a request that
carried a token triggers one shared renewal (`wx.login` again) and one replay, reads and writes
alike.

**The app config** (`src/app-config/`). `GET /api/v1/app/config` carries the shop's name and
logos, appearance, feature switches, the web-view allow-list and the server clock. The app paints
from the stored copy at once and revalidates with `If-None-Match`; the server caches the answer in
Redis (`app:config:v2`, 60 s), versions it with a weak ETag, answers `304` for the current
version, and drops the cache whenever a config group it is built from is saved.
`src/theme/` derives the page's colour tokens and the native tab bar's look from it.

**Decoration (decor v2).** A page the merchant designs goes through five layers
([mini/decor.md](mini/decor.md)):

1. **Admin editor**: `apps/web/src/admin/decor`, a Puck editor whose fields are generated from the
   block schemas (`zod-to-puck.ts`), with the blocks themselves as the canvas. It saves drafts,
   publishes revisions, rolls back and mints preview tokens through `/admin-api/decor/**`.
2. **Contracts**: `packages/contracts/src/decor`: the document (`schemaVersion`, root props,
   `blocks: [{id, type, v, props}]`), each block's `defineBlock` (props, version migrations,
   metadata, the data it needs), `LinkTarget`, data sources, and a lenient save / strict publish
   validation (DECOR-003).
3. **Resolver**: `packages/core/src/decor` resolves a published revision into a page: the public
   layer (block data looked up and cached per revision), the request layer (visibility by audience
   and platform) and the personal layer (the shopper's own counts and coupon states, never
   cached). `GET /api/v1/pages/{home,user-center,:id}` serves it; a preview token opens a draft,
   uncached (DECOR-012).
4. **Blocks**: `@shop/storefront-blocks` renders each block type from its props and resolved data,
   in the mini-program and in the editor canvas alike. `BlockList` skips a type it does not know,
   so an older mini-program survives a newer admin.
5. **Mini host**: `src/features/decor/decor-page.tsx` lays out a resolved page and answers the
   blocks' intents (open a link, sign in, contact support), since blocks call no WeChat API.

**The route catalogue.** `packages/contracts/src/system/storefront-routes.ts` names every page a
stored link may open, as an append-only key with typed params and its share, code, link and
notification capabilities. Decoration links, 小程序码, poster codes, subscription messages and
share paths store `{route, params}`, never a path. `encodeScene`/`decodeScene` pack the params
into a 小程序码's 32-byte scene; `GET /api/v1/share/mini-codes` asks WeChat for the code once and
caches it in `wechat_mini_codes` (SHARE-001).

**The WeChat compliance hooks** ([mini/wechat-compliance.md](mini/wechat-compliance.md), C01–C18),
each in one place:

- privacy (C04): `platform/privacy.ts` answers `onNeedPrivacyAuthorization` with the privacy
  sheet; `requiredPrivateInfos` declares only `chooseAddress`.
- sign-in (C05): no `getUserProfile`; the phone number only through the phone-number button.
- 确认收货 (C07): only through WeChat's receipt component (`platform/receipt.ts`), and the server
  uploads shipping information and handles the settlement push.
- subscription messages (C08): `platform/subscribe.ts`, only from a tap, scenes from the contract.
- content security (C09): reviews, nicknames and avatars pass `msgSecCheck`/`mediaCheckAsync` on
  the server; held content waits for the merchant (CONTENT-001).
- sharing (C10): each page's share menu comes from its catalogue entry (`platform/share.ts`), and
  `platform/launch.ts` handles the 朋友圈 single-page mode.
- web-view (C12): `platform/webview.ts` opens only a 业务域名 in the config's allow-list, and
  copies any other link (CLIENT-002).

**Checked by** the `mini` guard (pages ⇄ `app.config.ts` ⇄ route catalogue, the platform seam,
privacy declarations, share exports, retired URLs, no AppSecret or upload key), its unit tests,
and `pnpm --filter @shop/e2e-storefront test`; the rest only a real phone can show is in
[mini/device-check.md](mini/device-check.md).

## Edge

`docker/edge/nginx.conf`, in front of `web`:

- `/healthz` answers from nginx; `/readyz` proxies to the application's `/api/v1/readyz`.
- `= /` (the landing page, `apps/web/app/page.tsx`), `^/(admin|admin-api|api|scan-upload)(/|$)`
  and `/_next/static/` go to `web`; `/admin-api/notifications/stream` goes unbuffered, for SSE.
- `= /favicon.ico`, `= /icon.svg` and `= /robots.txt` go to `web`, which answers them from
  `apps/web/app` (`favicon.ico`, `icon.svg`, `robots.ts`: `Disallow: /`). Exact matches, so
  `/robots.txt` never reaches the verification-file rule below.
- `^~ /uploads/` serves the uploads volume read-only; anything that could execute is refused.
- `^/[A-Za-z0-9_-]+\.txt$` serves the WeChat domain-verification files from a read-only mount
  (`deploy/README.md`, "Domain verification files").
- Everything else is a relative `302` to `/`. The edge image carries no front-end files; the
  mini-program's H5 builds are never served in production.
- The client address is taken from `X-Forwarded-For` only when the peer is in
  `NEXT_EDGE_TRUSTED_PROXIES`; the app reads `X-Real-IP` and nothing else.

## Tests and checks

| Layer             | Where                        | Runs against                                                                                                                                              |
| ----------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit              | `*.test.ts` next to the code | Nothing external.                                                                                                                                         |
| Integration       | `*.int.test.ts`              | PostgreSQL and Redis in Testcontainers; `runConcurrently` for every conditional update.                                                                   |
| Contract examples | `packages/contracts`         | Every example parses against its route.                                                                                                                   |
| Guards            | `guards/`                    | The whole tree: contracts vs routes, permissions, retired features, secrets, migrations, the mini-program, the invariant catalogue, the release pipeline. |
| Admin e2e         | `e2e/admin`                  | The production build of `apps/web`, Playwright, fakes for every third party.                                                                              |
| Storefront e2e    | `e2e/storefront`             | The mini-program's "模拟小程序" H5 build in mobile Chromium, through the edge, against the built app and worker.                                          |
| Deploy drill      | `deploy/rehearsal/drill.sh`  | The production Compose stack, built locally: first deploy, upgrades that stop nothing or must roll back, rollback, backup, and `ship.sh`.                 |

CI (`.github/workflows/ci.yml`) runs all of them, and a nightly soak repeats the concurrency
suites 50 times with shuffled order.
