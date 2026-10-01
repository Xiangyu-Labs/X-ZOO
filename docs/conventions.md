# Engineering conventions

The rules the code follows. Most are enforced: by ESLint's import boundaries, by the guards
(`pnpm guards`), or by a test. The ones that are not are enforced in review.

[architecture.md](architecture.md) describes what the pieces are; this file says how to write
them. [contributing.md](contributing.md) has the merge checklist.

## Workspace

```
apps/web             Next.js App Router: admin UI, /admin-api/*, /api/v1/*
apps/worker          BullMQ worker and repeatable jobs
apps/mini            the WeChat mini-program (Taro 4, React 18)
packages/contracts   route contracts (zod) → OpenAPI; the single source of truth
packages/core        domain logic; kernel/ holds shared primitives
packages/db          Drizzle schema, migrations, reference seeds
packages/testing     Testcontainers harness, factories, fake gateways, mock server
packages/api-client  the typed /api/v1 client and route catalogue the mini-program uses
packages/storefront-blocks  DIY blocks shared by the mini-program and the admin editor
packages/config      shared ESLint, tsconfig and Vitest presets
e2e/, guards/        Playwright suites and whole-tree static checks
```

Package scope is `@shop/*`. Node ≥ 24, pnpm through corepack. TypeScript is strict, with
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. The admin UI is Ant Design 6 on
React 19.

## Where a domain's files go

A domain (`coupon`, `catalog`, `order`, …) lives in exactly these paths:

| Concern        | Path                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------- |
| Contracts      | `packages/contracts/src/<domain>/*.contract.ts`, `errors.ts`, `schemas.ts`                  |
| Domain logic   | `packages/core/src/<domain>/` (`*.service.ts`, `*.repo.ts`, `permissions.ts`, `effects.ts`) |
| Schema         | `packages/db/src/schema/<domain>.ts`                                                        |
| Admin API      | `apps/web/app/admin-api/<resource>/**/route.ts` (mirrors the contract path)                 |
| Storefront API | `apps/web/app/api/v1/<resource>/**/route.ts` (mirrors the contract path)                    |
| Admin pages    | `apps/web/app/admin/(shell)/<domain>/**`                                                    |
| Admin menu     | `apps/web/src/admin/menu/<domain>.menu.ts`                                                  |
| Jobs           | `apps/worker/src/jobs/<domain>.<verb>.ts`                                                   |
| Config groups  | `packages/core/src/<domain>/*.config.ts`: one file per group, nothing shared to edit        |
| Tests          | next to the code as `*.test.ts` (unit) and `*.int.test.ts` (needs PostgreSQL or Redis)      |

In the App Router the directory is the URL, so route files mirror the contract's `path` exactly. A
domain owns the top-level resource segments its contracts declare (coupon owns `coupons/**` and
`user-coupons/**`); the `contracts` guard rejects two routes with the same method and path. Import a
core domain by directory: `@shop/core/<domain>`.

Aggregation files (`*.gen.ts`) are produced by `pnpm gen` and gitignored. Add a file in the right
place and it is picked up: there is no shared index to edit, so two changes in different domains
never conflict. In `core` that covers `src/config-groups.gen.ts` (every `<domain>/*.config.ts`) and
`src/domains.gen.ts` (every `<domain>/index.ts`). A settings screen is one new `*.config.ts` file;
`gen` refuses two files that claim the same group name, and says which two.

**How a domain gets installed.** A domain registers **either** as a side effect of importing its
`index.ts`, **or** through one exported `register<Domain>Domain()` that `index.ts` declares and that
is safe to call twice. Never anywhere else: not from a job, a route or a service module.
`src/domains.gen.ts` imports every index and calls every registrar it finds; both apps import
`@shop/core/domains` exactly once at bootstrap (`apps/web/src/server/handle.ts`, and the worker's
container before its dispatcher and job registry exist). A registration made anywhere else depends
on which module a request happened to load first, and an effect handler registered that way can go
missing in the worker, where the effect then parks as `unknown`.

## Import boundaries (ESLint-enforced)

- `route.ts` files contain no business logic. They name the contract, call one service function
  and, for a write, name what was acted on for the audit log:
  `export const GET = handle(couponAdminList, (ctx, { query }) => coupon.adminList(ctx, query))`.
- `packages/core` never imports `next/*`, React, or `apps/*`.
- The admin UI imports `@shop/contracts` and its own API layer (`src/admin/api`) only, never
  `@shop/core` or `@shop/db`.
- A domain in `core` may import another domain only through that domain's `index.ts`, or through
  the ports in `core/src/order/ports.ts`. Never reach into another domain's repo or tables.
- Only `*.repo.ts` files touch Drizzle tables.

## Contracts

Every endpoint is a `defineRoute({...})` (see `packages/contracts/src/_conventions/route.ts`):

- Paths are plural nouns, kebab-case, with `:param` placeholders. Actions that are not CRUD are
  sub-resources with POST: `POST /api/v1/orders/:id/cancel`.
- JSON keys are camelCase. IDs are decimal strings. Money is a `"12.00"` string (`money`). Time is
  ISO-8601 with an offset (`instant`). Booleans are booleans. Absent optional values are omitted or
  `null`, never `""` or `0`.
- Lists use `pageQuery` and `paged(item)`. Sortable lists add `sortQuery([...keys])` (`sortBy` plus
  `sortOrder=asc|desc`); `CrudTable` sends exactly those keys.
- Every route has at least one example, and every example must parse against the route's schemas
  (`pnpm --filter @shop/contracts check:examples`). The mock server answers with the first example.
- Errors are a real HTTP status plus `{code, message, details?}`. Declare a domain's codes with
  `defineErrors` in `contracts/src/<domain>/errors.ts`, prefixed by the domain. Messages are
  Simplified Chinese and safe to show a user.
- Every route has a stable `id` (`coupon.adminCreate`) and an `auth` mode. Admin routes must
  declare `permission`. The storefront platform comes from the `X-Client-Platform` header.

## Domain rules

- **Transactions:** `withTx(async (tx) => …)`. Anything that calls a third party happens _after_
  commit, through the effects ledger, never inside the transaction.
- **State changes are conditional updates.** `UPDATE … WHERE id = $1 AND status = 'expected'`, then
  decide on the affected row count. Read-then-write on a status, stock, seats or a counter is a
  defect. Use `lockRow` (`SELECT … FOR UPDATE`) when several rows must agree, and `lockRows` to
  lock several in ascending id order.
- **Every conditional state change ships a concurrency test**, using `runConcurrently` from
  `@shop/testing`.
- **Money** is integer fen inside the domain, through `Money`; never a float.
- **Time:** inject `Clock`; never call `Date.now()` in domain code.
- **Side effects:** register handlers in `core/<domain>/effects.ts`. They must be idempotent,
  because the ledger retries.
- **Permissions:** declare atoms in `core/<domain>/permissions.ts` as
  `<domain>:<resource>:<action>`.
- **Config:** read through the typed registry (`ctx.config.get('payment')`), never by ad-hoc key.
  Every field has a default, so a group is readable before anyone has saved it.
- **Never:** `eval`, `new Function`, a `fetch` of a user-supplied URL outside
  `core/storage/safe-fetch.ts`, a client-supplied file path, a secret or token in a log.

## Admin UI

- Pages compose the kit in `apps/web/src/admin/kit/` (`CrudTable`, `ZodForm`, `ModalForm`,
  `AssetPicker`, `LinkPicker`, `ConfigGroupForm`, `Can`). If the kit lacks something, extend the
  kit rather than forking a private copy.
- Data access goes through `useRouteQuery` and `useRouteMutation` from `src/admin/api`; no
  hand-written `fetch`.
- Forms are typed from the contract's zod body schema.
- All user-facing text is Simplified Chinese. There is no i18n layer.
- The admin UI also runs the mini's two people-facing rules, from `@shop/config/eslint/ui`
  (`ui/no-void-handler`, `ui/no-raw-error-text`). A handler returns its promise so a Popconfirm or
  Modal `onOk` shows loading; `void message.success(…)` is fine, since antd's toast only settles
  when it closes. An error reaches the operator through `errorMessage(error, '…加载失败')` from
  `src/admin/api` (or under an `ApiError.is(error)` check), never as `error.message`.
- Read `apps/web/src/admin/kit/README.md` before building a page; `/admin/dev/kit` shows every
  component live.
- `exactOptionalPropertyTypes` is on: declare optional props as `?: T | undefined`, and spread
  `defined({...})` from `kit/props.ts` when handing a maybe-undefined value to an antd prop.
- Real asset and link data reach the pickers through `<AssetSourceProvider>` and
  `<LinkSourceProvider>`; the kit itself does not change.
- Secret config fields (`password` kind) travel to the browser as an "is set" boolean. Plaintext
  goes back only when retyped.
- A config group shapes its own screen from `ui`, not from the page. `section: '对象存储'` puts the
  field under a heading (in first-appearance order; no sections means no headings).
  `visibleWhen: { key: 'driver', equals: 's3' }`, or `equals: ['tencent', 'amap']` for any-of, shows
  it only for the driver it belongs to; `defineConfigGroup` throws if `key` is not another field of
  the same group. A hidden field is neither validated client-side nor sent, so its stored value
  survives: never hide a field the group cannot do without.
- In tests, match two-character CJK button labels with `zhName()` from `src/test/render.tsx`
  (antd inserts a space between the characters).

## The mini-program

`apps/mini` is the storefront; [docs/mini/](mini/README.md) is its design, and
[architecture.md](architecture.md#the-mini-program) describes how it is put together. What the
tools enforce there:

- Pages and features call WeChat only through `@/platform` (navigation, sign-in, payment,
  clipboard, the tab bar…), and import from `@tarojs/taro` only the lifecycle hooks. Components come from our own kit,
  `src/ui/` (no NutUI). Lint and the `mini` guard both say so; the guard also sees `wx.*`.
- `@shop/contracts` is imported as types only (a zod-free module is the exception, listed in
  `apps/mini/eslint.config.mjs`); the mini-program carries no zod. Data goes through
  `useRouteQuery`, `useInfiniteRouteQuery` and `useRouteMutation` from `@shop/api-client/react`;
  only the api-client calls `Taro.request`.
- A page is `<dir>/index.tsx` with its `index.config.ts`, registered in `app.config.ts`, and named
  by a key in the storefront route catalogue (`packages/contracts/src/system/storefront-routes.ts`).
  Code navigates with `navigate({ route, params })`; stored links hold `{ route, params }`, never a
  path. Catalogue keys are append-only: never rename or remove one that has shipped.
- A page's share menu is `useShare(route, …)`, and what it offers is the catalogue's `share` for
  that key; the guard compares the two.
- A privacy API is called only from `src/platform/`, listed in `PRIVACY_APIS`, and declared where
  WeChat requires it (`requiredPrivateInfos`, only `chooseAddress`), per
  [wechat-compliance.md](mini/wechat-compliance.md). A subscription request is made only from a
  tap handler.
- A decoration block is added once, in the contracts' registry and `@shop/storefront-blocks`
  ([mini/decor.md](mini/decor.md#8-新增一个块)); a block calls no WeChat API, but raises an intent
  the host page answers.
- The only AppIDs a committed file names are the shop's own mini-program, `wx4f4b772125e155ed` (a
  public identifier), and Taro's `touristappid`; a developer's own AppID and any API origin go in
  `apps/mini/.env.*.local` ([device-check.md](mini/device-check.md)). The AppSecret lives only in
  the server's config and miniprogram-ci's upload key outside the repository: the `mini` guard
  fails on a `private.*.key` or a 32-hex-digit token under `apps/mini`, and the size gate on one
  in `dist/weapp`.
- The weapp package has a size budget (`pnpm --filter @shop/mini size`), and the tab bar points
  only at the main package.
- Code that runs on the phone (`apps/mini/src`, `@shop/storefront-blocks`, the api-client's
  runtime) is linted by one preset, `@shop/config/eslint/weapp`. It refuses what iOS 12 or the
  WeChat runtime lacks, handler props written `() => void fn()`, and an error's own text
  (`.message`, `errMsg`, `String(error)`) reaching a toast, a modal or JSX; use `errorMessage()`.
  `tsconfig.weapp.json` also types `apps/mini/src` against the ES2018 library.
- A mini test answers requests only through `serveApi` (`src/test/fake-api.ts`). A stub for a
  route that does not exist, a request the contract refuses, a request nothing stubs, and an
  error the route does not declare or answers at the wrong status all fail the test. Lint refuses
  raw `taroFake.onRequest`, `fetch` and module mocks of the request layer.
- A trial build goes up only through `scripts/upload.mjs`. The tree must be clean, the build must
  be from HEAD, and HEAD must be on origin/master with a CI run that passed. `--dry-run` shows the
  command without running it ([device-check.md](mini/device-check.md#8-可选用-miniprogram-ci-出预览码或上传)).

## Out of scope

The product deliberately does not include: bargain, seckill, lottery, live streaming,
distribution/agent/brokerage, points and sign-in, paid membership and levels, balance and recharge,
payment methods other than WeChat Pay v3, store pickup and write-off, same-city delivery, a
self-built chat, a native app, upgrade or licence phone-home, a CRUD code generator, an online file
manager, database backup or clear-data screens, a route registry table, admin-defined timers or
events evaluated as code, a PC storefront and its decoration, an open API or MCP endpoint,
multi-language content, 一号通 cloud, receipt printers, an e-invoice provider. The `retired` guard
keeps their routes and switches out; adding one back is a product decision, not a refactor.

## Tooling caveats

- typescript-eslint does not support TypeScript 7 yet, so `apps/web` lints through
  `scripts/eslint-ts6.mjs`, which resolves `typescript` to a side-by-side 6.x alias; `tsc` stays
  on 7. Plain `.js`/`.mjs` files are not linted. Remove the shim once typescript-eslint supports
  TypeScript 7.
- Vitest 5 transforms with oxc; React packages need `oxc: { jsx: { runtime: 'automatic' } }`.
- `turbo` runs tasks in strict environment mode: a variable a task needs must be declared for it in
  `turbo.json`.

## Testing

- Unit tests (`*.test.ts`) touch nothing external. Integration tests (`*.int.test.ts`) run against
  real PostgreSQL and Redis from the Testcontainers harness in `@shop/testing`.
- Tests talk to the fakes in `@shop/testing` (WeChat, WeChat Pay, SMS, logistics), never to a real
  third party.
- A test that proves a business rule carries the rule's ID at the start of its `describe` or `it`
  title (`describe('COUPON-007 — the last coupon, claimed by two people at once', …)`), and the
  rule's row in [invariants.md](invariants.md) cites the test. See
  [contributing.md](contributing.md#business-rules).
- Time is moved with `fixedClock()` from the kernel, not by sleeping.

## Reporting

A failing or skipped test is stated as such, with its output. A test that is expected to fail
because of a known defect is `test.fail` with the reason next to it, so it turns red the day the
defect is fixed.
