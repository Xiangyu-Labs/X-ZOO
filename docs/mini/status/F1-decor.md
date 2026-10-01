# F1 — DIY v2 backend (`decor` domain): status

Branch `storefront/mini-F1-decor-backend`. Updated at every commit so the work can resume after an
interruption.

## Done

- R0 (storefront route catalogue) merged from `storefront/mini` (fast-forward to 6b4f48b96).
- Contracts `packages/contracts/src/decor/`: zod-free `constants.ts` (+ `ROUTE_LINK_LABELS`),
  `meta.ts` (editor-metadata conventions), `base.ts` (style + visibility base props,
  `blockProps`), `link.ts` / `link-route.ts` (`LinkTarget`, `route` = linkable catalogue route),
  `sources.ts` (data sources, `DataNeed`, resolved shapes), `registry.ts` (`defineBlock`,
  migrations, `compareVersions`), `blocks/*` + `all-blocks.ts` (carousel, imageCube, productGrid,
  userCard, orderEntry, serviceGrid), `document.ts` (envelope, `checkDocument`,
  `collectReferences`), `defaults.ts` (built-in 个人中心), `errors.ts`, `schemas.ts`,
  `examples.ts`, `decor.admin.contract.ts`, `decor.storefront.contract.ts`, `decor.test.ts`.
- `packages/storefront-blocks/src/schema/` is now a re-export shim over the contracts; blocks
  import types only (+ zod-free constants). S3 editor code in `apps/web/src/admin/decor` adapted to
  the new `route` link shape.

- DB `packages/db/src/schema/decor.ts` + migration `0004_decor.sql` (hand-added append-only
  trigger); `EXPECTED_MIGRATIONS` = 5.
- Core `packages/core/src/decor/`: repo, document service (CRUD, draft lock, publish, rollback,
  designate, preview token), reference checks (warnings), per-need resolvers, resolve service
  (cache per revision, visibility/platform/minClient filter, personal coupon state), permissions.
  `decor` added to the guards' install list.
- Route files: `apps/web/app/admin-api/decor/**`, `apps/web/app/api/v1/pages/**` (`_page.ts` reads
  `X-Client-Version`, computes the ETag). `pnpm guards` green.
- Core int tests: `packages/core/src/decor/decor.int.test.ts` (37) and
  `decor.concurrency.int.test.ts` (6: saves, publishes, publish-vs-save, rollbacks, designations,
  delete-vs-designate). All green.

- Web int tests: `apps/web/app/admin-api/decor/decor.int.test.ts` (8: permissions split, full
  lifecycle with audit targets, 422/404/409) and `apps/web/app/api/v1/pages/pages.int.test.ts`
  (7: 404 home, ETag/304, per-request filter, user-center default, preview token).
- `docs/invariants.md` DECOR-001…016 with citations; `docs/mini/decor.md` design doc.

- Response schema `resolvedPage.root.props` uses `servedRootProps` (no defaults) so the api-client
  `ResponseOf` stays exact (`packages/api-client/src/types.test.ts`).
- Merge checklist green (2026-09-23): turbo gen/typecheck/lint/test:unit/build; test:int --force
  (core 1436, web 319, worker 6, testing 9); prettier; check:examples (453 routes); guards (14/0);
  uni-app npm test (477 passed, 32 skipped); mini build size-report ok (main 381 KB, no zod).

## In progress

- Nothing. Branch ready for the coordinator.

## Next

- F2: un-hide `visibility.platforms` (multi-select), LinkPicker for parameterised routes.
- Open: per-version `minClient`; campaign manual picks limited to one list page of 100;
  `diyThemeTokens` typing (design.md §3.2) not done — it touches the legacy `diy` config.

## Decisions / deviations so far

- `platforms` visibility is `hidden` in the editor until F2 adds a multi-select control.
- Preview token: opaque random token in Redis, stored hashed (no signing secret exists in env).
  Response field is `previewToken` (the secrets guard reserves `token`).
