# Contributing

How a change gets in. Read [conventions.md](conventions.md) first;
[architecture.md](architecture.md) explains where things live.

## Before each commit

`pnpm install` points git at `.githooks/`, whose `pre-commit` checks the staged files in a few
seconds: Prettier, ESLint package by package, and, when the mini-program or a package it compiles
from source is touched, the `mini`, `mini-styles` and `banned` guards. It reads the working tree,
so stage whole files. It is a first net, not the checklist below.

## The merge checklist

Run from the repository root. Every step must pass; a step that cannot run is reported as not run,
with the reason, never as passed.

```sh
pnpm gen            # after adding or removing a contract, job, config group, menu or domain
pnpm turbo run gen typecheck lint test:unit build
pnpm turbo run test:int --force --concurrency=4
pnpm exec prettier --check .
pnpm --filter @shop/contracts check:examples
pnpm guards
pnpm turbo run build --filter @shop/web && pnpm --filter @shop/e2e-admin e2e
pnpm --filter @shop/e2e-storefront test
```

`turbo run … build` covers the whole workspace, the mini-program included: `apps/mini`,
`@shop/api-client` and `@shop/storefront-blocks` are typechecked, linted and unit-tested like any
other package, and `@shop/mini`'s `build` is the WeChat package, the H5 preview, the "模拟小程序"
H5 build and the size gate (`scripts/size-report.mjs`) in one. Every `taro build` there runs with
`--no-check`, which skips Taro's config doctor: the doctor fetches a schema from GitHub, rejects
a valid `compile.include`, and then exits 0 without building, leaving the old `dist/` in place
([S1 workaround 1](mini/spikes/S1-taro.md)). Keep the flag on any new build script. A Taro
build strips types without checking them, so a passing build proves nothing about types:
`typecheck` (`tsc --noEmit`) is that check.

| Step                | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typecheck`, `lint` | Strict types, and the import boundaries: no business logic in route files, `core` free of Next.js and React, the admin UI free of `core` and `db`, tables touched only by `*.repo.ts`.                                                                                                                                                                                                                                           |
| `test:unit`         | The pure logic. If the web suite flakes under turbo's parallelism, rerun `pnpm --filter @shop/web test:unit` on its own before calling it a failure (CI gives it a runner of its own for that reason).                                                                                                                                                                                                                           |
| `test:int`          | Services against real PostgreSQL and Redis, including every concurrency test. `--force` because a cached pass proves nothing about the current database. Needs Docker.                                                                                                                                                                                                                                                           |
| `prettier --check`  | Formatting.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `check:examples`    | Every contract example parses against its route's schemas, so the mock server and the docs show valid payloads.                                                                                                                                                                                                                                                                                                                  |
| `pnpm guards`       | The whole-tree checks: contracts and routes agree, permission atoms are declared and used, retired features stay out, no secrets, migrations are additive and numbered in order, the mini-program's pages, route catalogue, platform seam, privacy declarations and committed config agree (`mini`), the business-rule catalogue is consistent, the release pipeline keeps its rules. It must end with 0 failures and 0 pending. |
| admin e2e           | The admin console in a real browser, against the production build of `apps/web`. Build first: the suite serves whatever build exists, and a stale one hides fixes.                                                                                                                                                                                                                                                               |
| storefront e2e      | The mini-program's "模拟小程序" H5 build (`specs-mini/`) in mobile Chromium, through the edge, against the built app and worker, with fakes for WeChat sign-in and payment.                                                                                                                                                                                                                                                      |

Depending on what the change touches, also run:

- `apps/mini/**`, `packages/api-client/**` or `packages/storefront-blocks/**`: the checklist
  covers them (above); `pnpm --filter @shop/mini build` on its own is the quick way to see the
  package sizes. Anything that changes what runs on a phone (the platform seam, a page's first
  render, the tab bar, sign-in, payment) also gets a pass in 微信开发者工具 and on a real device,
  per [mini/device-check.md](mini/device-check.md); report what you could not check. The
  version in `apps/mini/package.json` is the `X-Client-Version` every request sends and the
  upload version; it changes only when the shop owner names a new one
  ([device-check.md §9](mini/device-check.md#9-版本号)).
- `deploy/**` or `docker/**`: shellcheck, as the `shell` job in `ci.yml` runs it, and the drill,
  `deploy/rehearsal/drill.sh` (it builds the three images; allow about half an hour; one shard is
  `--shard <name>`, see `--shards`; `--parallel` runs the shards side by side as CI does). Commit first: its `ship/` cases ship `HEAD`.
- `.github/**`: `actionlint`, and `.github/scripts/publish-release.test.sh` if the publish script
  changed.

CI (`.github/workflows/ci.yml`) runs the checklist, shellcheck, the publish-script proof and the
drill, as jobs side by side: `static` (guards, prettier, contract examples), `typecheck`, `lint`,
`unit` (the web package on one runner, the rest on another), `integration` (`@shop/core` in three
shards, the rest on a fourth), the two e2e suites (two shards each), `build`, and the drill (its
images built once, then one runner per shard). The wall time is the slowest of them, not their sum;
a job added here goes in `ci-gate`'s `needs`, and the `pipeline` guard holds that. The pass in
微信开发者工具 and on a real device is yours to run.

master merges through a merge queue (squash), and a pull request joins it on its own
(`auto-merge.yml`, as the merge App; not drafts, not forks, and a stacked pull request only once it
targets master). Its one required check is `ci-gate`. The heavy suites
run once, in the queue, on the merged result; a pull request runs the quick gate (`static`,
`typecheck`, `lint`, `unit`, `shell`), or nothing when it is prose only (`docs/**`, `*.md`, except `docs/invariants.md`); the
push to master that follows only publishes the images, since master is now the commit the queue
tested. A failure in the queue throws the pull request out; pushing a fix puts it back.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat(coupon): …`,
`fix(order): …`).

## Adding a route to an existing domain

1. **Contract.** In `packages/contracts/src/<domain>/<domain>.<surface>.contract.ts` add a
   `defineRoute({...})` with `id`, `method`, `path`, `auth`, `summary`, `tags`, `response` and
   `examples`, plus `permission`, `params`, `query`, `body`, `status` and `errors` as needed. Reuse
   the shapes in `_conventions/common.ts` (`id`, `money`, `instant`, `pageQuery`, `paged`,
   `sortQuery`). Give it at least one example.
2. **Errors.** A new failure the client must tell apart gets a code in the domain's `errors.ts`
   (`defineErrors`), with its HTTP status and a Chinese message; list it in the route's `errors`.
3. **Permission.** An admin route names an atom. If it is new, add it to the domain's
   `permissions.ts` (`definePermissions('<domain>', { '<resource>:<action>': '中文说明' })`).
4. **Service.** Implement it in `packages/core/src/<domain>/`: a service function taking
   `(ctx, input)`, database access in the domain's `*.repo.ts`. Follow the domain rules in
   [conventions.md](conventions.md#domain-rules): `withTx`, conditional updates, `Money`, `Clock`,
   third-party calls through the effects ledger.
5. **Route file.** Create `apps/web/app/<admin-api|api/v1>/<path>/route.ts` mirroring the contract
   path (`:id` becomes `[id]`):

   ```ts
   export const POST = handle(couponAdminCreate, async (ctx, { body }) => {
     const created = await coupon.adminCreate(ctx, body);
     ctx.audit(`coupon:${created.id}`);
     return created;
   });
   export const dynamic = 'force-dynamic';
   ```

6. **Tests.** A unit test for pure logic, an integration test for the service, and a
   `runConcurrently` test for every conditional state change.
7. **Admin page** (if any): under `apps/web/app/admin/(shell)/<domain>/`, built from the kit,
   calling the route through `useRouteQuery` / `useRouteMutation`. Add a menu entry in
   `apps/web/src/admin/menu/<domain>.menu.ts` with the atom that guards it.
8. **Mini-program** (if the storefront uses it): call the route by its `id` through
   `useRouteQuery` / `useRouteMutation` from `@shop/api-client/react` (`pnpm gen` adds it to the
   client's route table). Once the mini-program has shipped, a storefront route only grows: see the
   `api-compat` check in [guards/README.md](../guards/README.md#the-api-compat-check).
9. `pnpm gen`, then the checklist.

## Adding a domain

1. `packages/db/src/schema/<domain>.ts` for the tables, then a migration (below).
2. `packages/contracts/src/<domain>/`: `schemas.ts`, `errors.ts`, one `*.contract.ts` per surface
   (admin, storefront).
3. `packages/core/src/<domain>/`: `index.ts` (the domain's only public face), services, repos,
   `permissions.ts`, and as needed `effects.ts` (post-commit handlers), `*.config.ts` (settings) and
   port registrations. The domain installs itself either as a side effect of `index.ts` or through
   one exported `register<Domain>Domain()`; `pnpm gen` picks up both.
4. Routes, pages, menu and jobs as for any route.
5. If the domain acts on orders, go through the ports in `packages/core/src/order/ports.ts` (hooks,
   `PricingContributor`, `OrderKindHandler`), never through another domain's tables.

No shared index needs editing: `pnpm gen` finds the new files.

## Other additions

- **A job**: `apps/worker/src/jobs/<domain>.<verb>.ts` exporting `defineJob({...})` with a `name`,
  a payload `schema` and a `handler`, plus `repeat` for a scheduled one. The handler calls a
  service; the service enqueues through `ctx.queue`.
- **A settings screen**: `packages/core/src/<domain>/<name>.config.ts` with `defineConfigGroup`.
  Every field has a default. Read it with `ctx.config.get('<group>')`. The admin screen is a
  `<ConfigGroupForm>`.
- **A side effect**: record it in the transaction that changes state, and register an idempotent
  handler in the domain's `effects.ts`.
- **A third-party call**: behind a port in `core`, with a fake in `@shop/testing`. Tests never call
  the real service.

## Changing the schema

Edit `packages/db/src/schema/<domain>.ts`, then generate the migration:

```sh
pnpm --filter @shop/db db:generate
```

- Migrations are numbered in the order they merge, with no gap and no repeat (`pnpm guards`,
  `migrations`). Two pull requests written side by side each take the next number: the one that
  merges second renumbers when it rebases (rename the `.sql`, delete its snapshot, run
  `db:generate --custom` or `db:generate` again, put the SQL back, and fix the number in any test
  or doc that names the file). Say in the pull request which number you took.
- A migration that has been applied (anything already merged) never changes. Fix forward with a new
  one.
- Migrations are additive. A `DROP TABLE`, `DROP COLUMN` or `ALTER COLUMN … TYPE` needs a
  `-- destructive: approved` comment on the statement and a reason in the pull request; the guard
  refuses it otherwise. Production upgrades roll back to the previous images, which must still run
  on the new schema.
- Check it with `pnpm --filter @shop/db db:migrate` against a scratch database and with the
  integration tests.

## Business rules

[invariants.md](invariants.md) is the catalogue of the shop's business rules. Each rule has an ID
(`COUPON-007`, `PRICE-004`: an upper-case area and a three-digit number), a statement of the rule,
and the tests that prove it.

- **Cite a rule from a test** by starting the `describe` or `it` title with its ID:

  ```ts
  describe('COUPON-007 — the last coupon, claimed by two people at once', () => { … });
  ```

- **Cite a test from the catalogue** as `<file>::<title path>`, where the file is relative to the
  repository root and the title path joins the nested `describe` and `it` titles with `>`:

  ```
  packages/core/src/coupon/coupon.concurrency.int.test.ts::COUPON-007 — the last coupon, claimed by two people at once > …
  ```

- **A new rule** gets the next free number in its area, a row in the catalogue, and at least one
  test that proves it. A rule that a guard enforces cites the guard's check instead.
- **Changing a rule's behaviour** means changing its row in the same pull request. Renaming or
  moving a test means updating the rows that cite it.

The `invariants` guard fails when a row cites no test, when a cited test does not exist, when an ID
appears twice, or when a test names an ID the catalogue does not have.
