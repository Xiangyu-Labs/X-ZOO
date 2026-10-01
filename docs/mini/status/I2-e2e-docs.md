# I2 (end-to-end coverage, invariants, docs) — status

Branch `storefront/mini-I2-e2e-docs`, worktree `/home/xiangyu/Projects/x-zoo-mini-wt/I2-e2e-docs`.
Brief: e2e coverage matrix (legacy specs + SMOKE rows → `specs-mini/`), the missing mini specs,
mini citations in `docs/invariants.md`, the mini sections of `architecture.md` / `conventions.md`,
`docs/mini/README.md`, `docs/mini/cutover.md`, CI sanity.

## Done

- Baseline: `test:mini` 15/15 green on `storefront/mini` at `91e3893fc`.
- `specs-mini/decor.spec.ts` + `src/mini-pages/decor-pages.ts`: a page published through the
  admin API with ten block types renders each in order on the 微页面 and follows the next
  publish; the preview token (DECOR-012); the web-view 业务域名 allow-list (allowed → web-view
  page, other → copied).
- `specs-mini/login.spec.ts`: silent sign-in, SMS sign-up (wrong code counted, code stays usable),
  401 renewal with read replay, 401 renewal with a write replayed once.
- `specs-mini/share.spec.ts`: a 小程序码 for product, 拼团, 预售, 领券中心 (`_`) and a 微页面 opens
  its page from the `(page, scene)` the server cached (SHARE-001).
- `specs-mini/coupons.spec.ts`: a category-scoped coupon at 确认订单; a presale with a stacked
  coupon on the order pages — **`test.fail`: the mini 订单详情 prints ¥88.00 (catalogue
  `unitPrice`) and 优惠券 -¥15.00 (activity + coupon) where the uni-app prints ¥78.00 / ¥5.00.**
- `specs-mini/app-config.spec.ts`: ETag / 304 / new version after a save; the login page shows
  the shop's logo and name. `share.spec.ts` also: 分享 → 生成分享海报 asks for the product's code.
- `login.spec.ts`: the terms gate before 手机号快速登录.
- `specs-mini/reviews.spec.ts`: a held review appears only once the merchant publishes it
  (CONTENT-001); a clean one appears at once and leaves when hidden.

- `docs/mini/e2e-coverage.md`: every legacy scenario, SMOKE row and §12 journey → mini spec,
  with the gaps (password login not built; privacy sheet not emulable on H5; presale order
  pages known-failing; account pages pending E).
- `docs/invariants.md`: SMOKE-002…005 cite a mini spec beside the legacy one (statements name
  both clients); mini citations added to AUTH-007, AUTH-008, DECOR-012, DECOR-013, SHARE-001,
  CONTENT-001, SYS-019; new CLIENT-002 (the web-view 业务域名 rule, unit + e2e). `pnpm guards`
  green.

- `docs/architecture.md`: "The mobile clients" — the mini-program (structure, platform seam,
  session, app config, the decor v2 pipeline, route catalogue, compliance hooks) and the uni-app
  marked legacy; `decor` domain, `api-client` / `storefront-blocks` packages, edge `/` noted as
  the uni-app until the cutover. `docs/conventions.md`: the mini-program rules, the uni-app
  marked legacy.

- `docs/mini/README.md`: the doc map, the builds, dev H5 (layout only / the e2e stack for
  data), 微信开发者工具 and device check, unit / guards / e2e (cold and warm stack).
- `docs/mini/cutover.md` (plan only): preconditions; a proposed three-release order (A: new
  backend, nothing deleted, 审核; B: deletions + landing page; C: DROP per OPS-007) for the user
  to decide; the deletion checklist (uni-app, legacy e2e, legacy diy — move
  `admin/diy/{data-source,record-source}` out first —, the 7 helper routes, staff routes,
  `MINI_CODE_PAGES` + `/wechat/mini-qrcodes`, notification `link` + `wechatMini.page` with the
  OA template-message decision, the `uniapp` guard, CI, edge `/` → landing); what not to drop;
  公众平台 actions by release; rollback.
  _Note (2026-09-24, L3): the user chose a single release; cutover.md was rewritten accordingly
  and no longer has releases A/B/C or the OA template-message decision (there is no 公众号)._

- CI: both storefront jobs run their whole testDir (`test` → `specs/`, `test:mini` →
  `specs-mini/`); stale timing comments in `storefront-e2e-mini` fixed. actionlint is not
  installed here, so the workflow was only YAML-parsed.

## Final checklist (2026-09-24, at `fc5a10bfe`; `storefront/mini` still `91e3893fc`, merge a no-op)

- `pnpm turbo run gen typecheck lint test:unit build`: pass (45/45).
- `pnpm --filter @shop/e2e-storefront test:mini`: pass, 30 (the presale-coupon test is the
  intended `test.fail`, and fails as expected).
- `pnpm --filter @shop/e2e-storefront test`: pass, 34 (first run could not start: this worktree
  lacked `apps/uni-app/node_modules`; after `npm ci` there, green).
- `pnpm turbo run build --filter @shop/web && pnpm --filter @shop/e2e-admin e2e`: pass, 50.
- `pnpm exec prettier --check .`: pass. `pnpm guards`: 15 checks, 0 failures.
- actionlint: not installed, not run; `ci.yml` YAML-parses.

## In progress

- Nothing.

## Pending

- Account-page (E) specs: E had not merged into `storefront/mini` when this stream finished.
- For other streams: the presale order-page price bug (`coupons.spec.ts` `test.fail`); password
  login not built; privacy sheet only on device (D03).
