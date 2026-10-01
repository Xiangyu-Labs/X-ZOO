# `@shop/guards`

Static assertions about the whole tree, run as one command:

```sh
pnpm guards                                   # from the repository root — every check
pnpm --filter @shop/guards guards --quiet     # only the summary and the failures
pnpm --filter @shop/guards guards contracts permissions   # one or more by name
pnpm --filter @shop/guards guards --json      # for CI annotations
```

It exits non-zero if anything **fails**, and zero otherwise. `pnpm guards` is a
turbo task, so it runs `gen` first — the checks read the generated route
registry, not the filesystem's idea of it — and it passes no arguments through;
use the `--filter` form for flags.

## Why a package and not a lint rule

Lint sees one file at a time. Every property here is about _two_ things
agreeing — a contract and a directory, a permission atom and a menu entry, a
storefront call and a route, a business rule and the test that proves it, the
release workflow and the script it calls.

## Two verdicts

| level  | meaning               | fatal |
| ------ | --------------------- | ----- |
| `fail` | broken now            | yes   |
| `note` | context worth reading | no    |

There is no "known, fix later" level. A property that is allowed to be false
somewhere is an entry in an allow-list inside the check, with the reason next
to it (below). The last line is the count:

```
20 checks, 0 failure(s)
```

## The checks

| name                | asserts                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domains`           | every domain in `domains.gen.ts` is imported by name, so its registrations really run                                                                                                                                                                                                                                                                                                        |
| `contracts`         | contract ⇄ route file, both ways, and the folder's `[param]` is the contract's `:param` (ROUTE-001)                                                                                                                                                                                                                                                                                          |
| `route-hygiene`     | `dynamic = 'force-dynamic'` everywhere; `ctx.audit(target)` on every admin write                                                                                                                                                                                                                                                                                                             |
| `permissions`       | every route and menu atom is declared; every declared atom is used                                                                                                                                                                                                                                                                                                                           |
| `admin-client`      | no hand-built `/admin-api/…` URL and no raw `fetch()` outside the api seam                                                                                                                                                                                                                                                                                                                   |
| `admin-permissions` | from every admin page, following imports symbol by symbol: each write route used is under a `<Can>` / `can()` for its atom, each read is required by the page's menu entry, gated, or granted with a held write atom in `PERMISSION_REQUIREMENTS` (GUARD-005, AGENTS rule 11)                                                                                                                |
| `fixtures`          | a web test that stubs the API answers through `respondWith`, so every fixture is parsed by its contract                                                                                                                                                                                                                                                                                      |
| `mini`              | the Taro mini-program: pages ⇄ `app.config.ts` ⇄ route catalogue, the platform seam, no NutUI, privacy, committed config, no upload key or AppSecret                                                                                                                                                                                                                                         |
| `mini-styles`       | the mini-program's `.scss` uses only what WXSS and the iOS 12 WebView accept: no `*`, `:is/:where/:has/:hover/:focus-visible`, `@supports`, HTML tag or attribute selectors, `aspect-ratio`, `inset`                                                                                                                                                                                         |
| `retired`           | no feature the shop does not have comes back as an identifier or a URL token (CORE-002)                                                                                                                                                                                                                                                                                                      |
| `banned`            | no `eval`, `new Function`, `child_process`, `dangerouslySetInnerHTML`; the core clock lint rule is still an error; `eval` / `new Function` also in the mini-program and its two shared packages                                                                                                                                                                                              |
| `secrets`           | no secret config field can leave through a response schema                                                                                                                                                                                                                                                                                                                                   |
| `personal-data`     | no response carries a credential or cross-app id (password hash, `openid`, 卡密) unless masked or staff-only and listed; phone, real name, e-mail leave a non-admin route only as the shopper's own record or the shop's (GUARD-004)                                                                                                                                                         |
| `tx-pool`           | no `ctx.config.get(` / `ctx.db` / `ctx.withTx(` inside a function that takes a `tx`, `Tx` or `DbOrTx` (STAB-001)                                                                                                                                                                                                                                                                             |
| `counters`          | every counter column (`stock`, `sales`, `quota`, refunded / shipped quantities…) in a `.set({…})` moves by `sql`, is a literal reset, or sits in a compare-and-set whose `where` reads it (GUARD-001, AGENTS rule 6)                                                                                                                                                                         |
| `literals`          | every `pageSize` literal a client sends is within the contract's cap; no date cut out of a UTC `toISOString()` or an instant field; UI `toISOString()` only in files that put it on the wire (GUARD-002, GUARD-003)                                                                                                                                                                          |
| `migrations`        | every destructive statement in `packages/db/migrations` carries `-- destructive: approved` (OPS-007)                                                                                                                                                                                                                                                                                         |
| `pipeline`          | `ci.yml` publishes through `publish-release.sh`, never promotes, keeps its guards, soak and admin e2e gates, runs every shard the drill names, and its trigger filter never skips a file a guard reads (REL-*); `ci-gate` needs every gate job; `deploy.yml` alone ships, follows the gate by name and waits in `production`, and uploads the mini-program only from a job that needs `ship` |
| `api-compat`        | the storefront API (`/api/v1/**` in the generated OpenAPI) only grows against `baselines/storefront-api.json`, the surface the released mini-program uses; report-only until the first release                                                                                                                                                                                               |
| `invariants`        | every rule in `docs/invariants.md` cites a test that exists, and every rule a test title names exists                                                                                                                                                                                                                                                                                        |

## The allow-lists

Every list here is **exactly compared**: an entry that stops applying is a
failure telling you to delete it. That is the whole difference between a
baseline and a hiding place.

- `checks/route-hygiene.ts` — `AUDIT_EXEMPT`: admin writes with no audit
  target — the login (every outcome is audited under `auth.adminLogin`), the
  POST-shaped `sku-matrix` read and the two inbox "mark read" routes. An entry
  fails when its URL stops being an admin write **or** its route file starts
  calling `ctx.audit(target)`.
- `checks/contracts.ts` — `UNCONTRACTED`: the one route file with no contract,
  the notification SSE stream (`defineRoute` cannot describe an event stream).
  Since it bypasses `handle()`, the check also asserts the file resolves the
  admin session itself.
- `checks/admin-client.ts` — `HAND_BUILT`: the matching client end, the bell's
  `EventSource`. Fails if the URL ever grows a contract.
- `checks/fixtures.ts` — `RAW_ALLOWED`: `call-route.test.ts`, which tests the
  transport itself and so must build raw responses.
- `checks/mini.ts` — `UNBUILT_ROUTES`: storefront route keys whose page the
  mini-program has not built; an entry fails once its page is registered or
  its key leaves the catalogue. `UNCATALOGUED_PAGES`: registered pages with no
  route key, with the reason. Both are empty: every catalogue page is built
  and every page is catalogued.
- `checks/retired.ts` — `ALLOWED` and `DENY_LISTS`: the files that name a
  retired feature in order to refuse it.
- `checks/banned.ts` — `FETCH_ALLOW` (one file per entry, with the host it
  builds; `fetch(` and `globalThis.fetch(` both count as a call) and the
  sanitised renderers.
- `checks/personal-data.ts` — `NEVER_ALLOW` (a credential-named field that
  may leave: the masked 渠道码 scan `openid`, whose masking line must still
  exist, and the staff 卡密 pool) and `OWN_OR_SHOP` (whose personal data a
  storefront route returns: the shopper's own, or the shop's).
- `checks/counters.ts` — `COUNTER_ALLOW`: counter writes that cannot be stale
  (an activity edit resolved against locked rows, a SQL recount). Keyed on the
  trimmed `key: value` text.
- `checks/literals.ts` — `UTC_CUT_ALLOW` (a UTC date that is meant to be UTC:
  the Tencent Cloud signature) and `UI_ISO_FILES` (UI files whose
  `toISOString()` only goes onto the wire).
- `checks/admin-permissions.ts` — `UNGATED_ALLOW`: admin controls that use a
  route without its atom, keyed on the file and route id (empty).
- `checks/tx-pool.ts` — `TX_POOL_ALLOW`: reads proven harmless (empty). Keyed
  on the trimmed source line, so editing an excused line makes it a finding
  again.

## The `mini` check

`apps/mini` read against `@shop/contracts/system/storefront-routes` and
[`docs/mini/wechat-compliance.md`](../docs/mini/wechat-compliance.md). Every
finding is tagged with its rule:

| rule            | asserts                                                                                                                                                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[pages]`       | every page `app.config.ts` registers has its source; every page file (`<name>.config.ts` + `<name>.tsx` under `src/pages`, `src/packages`, `src/subpackages`) is registered; tabBar pages are in the main package; dev-only pages live in `subpackages/demo`, which nothing imports |
| `[routes]`      | every catalogue path is a registered page, every registered page (demo aside) has a route key, and the `tab: true` keys are the tab bar: `platform/tab-pages.ts` keys and `tabBar.list` paths                                                                                       |
| `[platform]`    | no `Taro.x` / `wx.x`, no `@tarojs/taro` import but the lifecycle hooks, and no private `openType` (phone, avatar, privacy) outside `src/platform/` — in the app, `@shop/api-client` and `@shop/storefront-blocks`; no `getUserProfile` / `getUserInfo` anywhere (C05)               |
| `[nutui]`       | no `@nutui/*` anywhere (scripts and stylesheets), in `apps/mini/src` (`src/ui/` included) or the shared packages: NutUI was removed, the kit is our own                                                                                                                             |
| `[privacy]`     | every `requiredPrivateInfos` API the app calls is declared, and only `chooseAddress` may be (C04); once `platform/privacy.ts` exists, every privacy-guarded API the platform uses is in its `PRIVACY_APIS`                                                                          |
| `[retired]`     | no retired feature (the `retired` word list) in a page path, a catalogue path, or a page/API URL literal                                                                                                                                                                            |
| `[config]`      | `project.config.json` keeps `urlCheck: true`; the only AppIDs a committed file (`project.config.json`, `.env*` but `.env.*.local`) may name are the shop's `wx4f4b772125e155ed` and `touristappid`; no committed `.env*` sets an `http://` `TARO_APP_API_ORIGIN` (C03)              |
| `[credentials]` | no miniprogram-ci upload key (`private.*.key`) under `apps/mini` or tracked anywhere in git; no 32-hex-digit AppSecret-shaped token in any file under `apps/mini` (build output aside — `scripts/size-report.mjs` scans `dist/weapp` for the same)                                  |

`app.config.ts` is evaluated the way Taro's config compiler does (an ES module
whose default export is `defineAppConfig({...})`), so the check sees the
manifest the build writes, including the parts computed from `TAB_PAGES`.
Tests (`*.test.*`, `src/test/`) are exempt from `[platform]`, `[nutui]` and
`[privacy]`.

## The `api-compat` check

A released mini-program version stays on phones for weeks, so once one is out
the storefront API must keep answering what it sends and keep sending what it
reads. `baselines/storefront-api.json` is the `/api/v1/**` part of the OpenAPI
document `pnpm gen` writes, reduced to what a client depends on (parameters,
body, success status and body; no prose), as the last released version saw
it. The check diffs today's document against it (`lib/api-compat.ts`):

| breaking (fails once enforced)                                                                                                                                                              | passes                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| a path or method removed                                                                                                                                                                    | a new path, method, optional parameter or optional request field                                   |
| response: a field removed, made optional or made nullable; an enum value or union variant removed; a type changed                                                                           | response: a new field; a new enum value or variant (printed as a note: old clients do not know it) |
| request: a field or parameter made required (a new required one too), removed, or narrowed — an enum value, `null` or a type no longer accepted, a tighter length, bound, pattern or format | request: anything widened                                                                          |

A union is matched branch by branch on its tag (`object(kind=product)`), so
reordering branches changes nothing. Response limits are not compared: the
production build does not validate responses.

**Report-only.** `ENFORCED` at the top of `checks/api-compat.ts` is the
switch: `false` prints each breaking change as a note
(`[breaking, report-only]`) and passes; `true` fails. It stays `false` through
the first mini-program release; whether and when to flip it is decided after
that release ([cutover.md §5](../docs/mini/cutover.md#5-商城接口兼容守卫api-compat)).

**The refresh command**, run only when a mini-program version is released:

```sh
pnpm --filter @shop/guards api-compat:refresh --release <x.y.z>   # apps/mini/package.json `version`
pnpm --filter @shop/guards api-compat:refresh --unreleased        # before the first release only
```

It regenerates the contracts' OpenAPI document, prints the breaking changes the
new baseline forgives (put them in the commit message), and rewrites the file.
`--unreleased` is refused once the baseline records a release. The file is
generated: never edit it by hand, and after a merge that changes `/api/v1`
before the first release, regenerate it with `--unreleased`.

## Tests

`pnpm --filter @shop/guards test:unit` covers the readers (test titles, the catalogue, transaction scanning, migrations, the workflow)
against small strings, and runs two checks over the real tree as tests:
`checks/contracts.test.ts` (ROUTE-001) and `checks/retired.test.ts` (CORE-002).

`checks/mini.mutations.test.ts` proves the `mini` check by mutation, on every
commit: each mutant in `scripts/mutations/mini.ts` (at least one per rule) is
applied to a scratch copy of `apps/mini` and the check must fail with that
rule's tag; the unmutated copy must pass, and so must a copy committing the
shop's own AppID. Its turbo inputs include all of `apps/mini` but build output
and the two shared packages, so a cached pass is never replayed over a changed
app.

## Mutations

The `mini` mutants run in-process with the unit tests (above). The rest of this
section is MUT-001.

`pnpm --filter @shop/guards mutations` applies each of the ten mutations in
`scripts/mutations/mutations.ts` to a temporary copy of the tree and expects the
tests that guard it to fail (MUT-001). It runs integration tests, so it needs
Docker, and it runs nightly rather than in `pnpm guards`; `src/mutations.test.ts` keeps its
catalogue honest on every commit.
