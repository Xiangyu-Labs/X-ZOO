# I1 — guards, CI, docs: status

Branch `storefront/mini-I1-guards-ci`, from `storefront/mini` (R0's route catalogue merged in at
`6b4f48b96`).

## Done

- **`mini` guard** (`guards/src/checks/mini.ts`, readers in `guards/src/lib/mini.ts`), the 15th
  check. Eight tagged rules: `[pages]`, `[routes]`, `[platform]`, `[nutui]`, `[privacy]`,
  `[retired]`, `[config]`, `[credentials]` (see `guards/README.md`). `uniapp` is untouched.
  - Route parity runs against R0's catalogue (51 keys). `UNBUILT_ROUTES` excuses the 44 keys whose
    page is not built yet, and `UNCATALOGUED_PAGES` the shell's `pages/home/index` (the catalogue's
    `home` is `pages/index/index`). Both lists are exactly compared, so they only shrink as
    streams A and B register pages.
  - `[config]`: a committed `project.config.json` / `.env*` may name only the shop's own AppID
    `wx4f4b772125e155ed` or `touristappid`.
  - `[credentials]`: no `private.*.key` under `apps/mini` or tracked anywhere in git, no
    32-hex-digit AppSecret-shaped token in any file under `apps/mini`. `scripts/size-report.mjs`
    scans `dist/weapp` for the same; `.gitignore` ignores `private.*.key`.
- **Mutation tests**: `guards/scripts/mutations/mini.ts` (27 mutants, every rule covered) plus one
  shared-package mutant and an "official AppID is accepted" case, run by
  `guards/src/checks/mini.mutations.test.ts` in the unit suite. All killed; the baseline copy
  passes.
- `retired` scans `apps/mini/src`, `packages/api-client/src` and `packages/storefront-blocks/src`;
  `banned` bans `eval` / `new Function` there too; `invariants` already read the whole repository
  and now has a test that proves it reads the mini-program's tests.
- `guards/turbo.json`: `test:unit` inputs include all of `apps/mini` but build output, and the two
  shared packages, so a cached pass is not replayed over a changed app.
- **CI** (`.github/workflows/ci.yml`, not run; actionlint clean): a separate `storefront-e2e-mini`
  job runs `test:mini`; both storefront e2e jobs cache the `next build` output; the static job's
  `turbo run … build` already builds weapp + H5 + the size gate, so no new build step. The images
  job is unchanged.
- **Docs**: `contributing.md` (checklist, `--no-check`, `apps/mini/**` item), `architecture.md` and
  `conventions.md` ("in progress" mini-program sections; the uni-app sections stay),
  `docs/mini/device-check.md` (Chinese; official AppID, members, backends, WSL2 networking,
  checklist D01–D12, report template, optional miniprogram-ci path).
- **Scripts**: `apps/mini/scripts/device-build.mjs` (checked weapp build for DevTools / a phone)
  and `apps/mini/scripts/preview.mjs` (miniprogram-ci preview; refuses without
  `WX_MINI_UPLOAD_KEY_PATH` outside the repo, without `--confirm`, or without the CLI installed).
  `preview.mjs` has never been run against WeChat.

## Open

- Merge order: if stream A's page skeleton merges before this branch, `UNBUILT_ROUTES` /
  `UNCATALOGUED_PAGES` entries for the pages A registers become stale and `pnpm guards` fails
  until they are deleted (by design). Either merge this first and let A shrink the lists, or
  merge A first and I shrink them here.
- `apps/mini/.env.development` / `.env.production` comments still say a real AppID never goes
  there; with the official AppID now allowed, stream A may switch them to `wx4f4b772125e155ed`.
- A real-device sign-in against the e2e fakes fails (`40029`): the fake `jscode2session` only knows
  seeded codes. A "device mode" in `@shop/testing` that accepts any code would make backend B
  usable for D04.
