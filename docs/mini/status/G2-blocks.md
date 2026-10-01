# G2 — DIY blocks, batch 2: status

Branch `storefront/mini-G2-blocks` (from `storefront/mini`). Updated at every commit so the work can
resume after an interruption.

Baseline mini build before G2 (`pnpm --filter @shop/mini build:weapp`, production weapp, demo
package excluded): main 501.2 KB, goods 6.4, order 83.8, aftersale 68.0, promo 12.9, account 27.4,
content 4.8, page 1.6, total 706.1 KB; react ×1; no zod.

Blocks: `couponList` 优惠券, `newcomerCoupon` 新人券, `groupbuyList` 拼团, `presaleList` 预售,
`articleList` 资讯, `video` 视频, `floatingContact` 悬浮客服, `followOfficialAccount` 关注公众号.

## Done

- **Contracts** (`packages/contracts/src/decor/`):
  - Block files: `coupon-list.ts`, `newcomer-coupon.ts`, `campaign-list.ts` (拼团 + 预售),
    `article-list.ts`, `video.ts`, `floating-contact.ts`, `follow-official-account.ts`, shared
    `list-heading.ts` (title + 「更多」). Registered in `all-blocks.ts`.
  - `constants.ts` (zod-free): `COUPON_LIST_LAYOUTS`, `CAMPAIGN_LIST_LAYOUTS`,
    `ARTICLE_LIST_LAYOUTS`, `VIDEO_RATIOS`, `FLOATING_SIDES`, `FLOATING_BOTTOM`.
  - `meta.ts`: field kind `video`.
  - `sources.ts`: personal need `newcomerCoupons { limit }`, slot `{ kind: 'newcomerCoupons',
coupons: HeldCoupon[] }`.
  - `floatingContact` and `followOfficialAccount` are `maxPerPage: 1` (DECOR-018).
  - `examples.ts`: one example per new block. Tests in `blocks.test.ts` ("the batch-2 blocks").
- **Core**:
  - `groupbuy.cardsFor(ctx, ids)` / `presale.cardsFor(ctx, ids)`: additive, read-only; the same
    visibility as `list`, in the given order, one query (repo `listActivities` gained an additive
    `ids` filter). Used by the decor resolvers and the reference checker instead of reading one
    list page of 100 and picking — the 100-campaign limit is gone. Int tests in both domains.
  - `coupon.listHeldNewUser(ctx, limit)` (repo `listUnusedBySource`): additive, read-only, tested.
  - `decor-resolve.service.ts`: the `newcomerCoupons` personal need, fetched once per request
    (largest limit, capped at 10), never cached.
  - `decor.int.test.ts` "the batch-2 blocks (G2)": 8 tests (DECOR-004/013/015/018).
- **Docs**: `docs/invariants.md` DECOR-015 text + citations, DECOR-013/004 citations, new DECOR-018.
- **storefront-blocks**: components `coupon-list`, `newcomer-coupon`, `campaign-list`
  (`groupbuy-list`, `presale-list`, shared `campaign-cards`), `article-list`, `video`,
  `floating-contact`, `follow-official-account`; all in `BLOCK_COMPONENTS`.
  - `BlockIntent` gains `claimCoupon { templateId }`, `claimNewcomerCoupons`, `officialAccount`.
  - `BlockProps.host` / `BlockListProps.host` (`BlockHost`: `signedIn`, `serverNow`, `canvas`,
    `overlayOpen`); `BlockList` derives `signedIn` from `personal`.
  - Shared: `list-head.tsx` (title + 更多), `time.ts` (Beijing-time dates, countdown, phase),
    `money.ts`, `personal.ts` (`couponStatesIn`, `heldCouponsIn`), tokens `$shadow-float`,
    `$z-bar`, icon `contact`.
  - DOM shim: `Video` (300×225, contained, autoplay only muted).
  - Fixtures for every new block (`FIXTURE_NOW` / `fixtureServerNow` for the countdown,
    `fixturePersonalG2`). Tests: `marketing-blocks.test.tsx` (27 × React 18 + 19), registry test.

- **Public lists**: `GET /api/v1/groupbuy/activities` and `/api/v1/presale/activities` take
  `ids` (指定数据, in order, invisible skipped, ≤100 → 422), through `cardsFor`, like
  `/api/v1/coupons` and `/api/v1/articles` already did. Contract `picked` examples;
  `picked-lists.int.test.ts` covers both.
- **Admin**:
  - Field kind `video`: `VideoField` (`fields/basic.tsx`) — 素材库 pick (`accept="video/mp4"`, a
    non-mp4 pick is refused with a message), pasted URL, muted metadata-only preview.
    `AssetPicker` draws a video tile as a `<video>` frame instead of a broken `<img>`.
    Tests: `fields/video-field.test.tsx`.
  - The canvas passes `host={{ canvas: true }}` to every block.
  - Canvas data (`canvas-data.tsx`) now previews coupons, 新人券, 拼团, 预售 and 资讯 through
    the storefront's public lists (the resolver's filters, as a guest). Tests in `canvas.test.tsx`
    and "the batch-2 blocks on the canvas" in `canvas-blocks.test.tsx`.

  - Templates: 简约首页 gains a 领券中心 row (`couponList`, all claimable, first 3; hides itself
    when there are none). No other template changed: 新人券 beside it would be a second coupon
    row, and 拼团 / 预售 / 资讯 / 视频 need this shop's records or media. Still no stock photos.
  - Sandbox `/admin/dev/decor-spike`: the eight new blocks, canvas data and pickers from the
    fixtures.
- **Mini demo page** (`subpackages/demo/pages/blocks`): all 22 blocks; `?canvas=1` draws what the
  canvas draws, otherwise the live look (fixture shopper, `serverNow`, `renderIntent` wrappers).
- **Fidelity** (`docs/mini/status/G2-fidelity/README.md`): 22 blocks, the same size on both sides;
  20 within 3 %, `richText` 3.68 % (G1's known residual) and `followOfficialAccount` 3.86 % (glyph
  edges only) flagged. `fidelity/run.ts` extended and now waits for canvas records and lazy images.
- **Mini size**: `build:weapp` main 501.2 KB, total 706.1 KB — unchanged, since no production page
  renders `BlockList` yet (the demo package is left out of production weapp). No zod in
  `dist/weapp` or `dist/h5`.

- **Docs** `docs/mini/decor.md`: §2.2 by-id campaigns and `ids` on the public lists, §2.3 the eight
  blocks, intents, `BlockHost`, DECOR-018, the WeChat 关注公众号 scene limits, video; new §2.4
  host wrappers for the page streams; §6 the `newcomerCoupons` personal need; §8 editor field and
  canvas-data steps; §9 the video control and canvas data; §10 the 100-campaign item removed.

- **Checklist** (2026-09-24, all pass):
  - `pnpm turbo run gen typecheck lint test:unit build`: 45/45 tasks. Unit tests: web 872,
    storefront-blocks 160, contracts 383, core 743, mini 224.
  - `pnpm turbo run test:int --force --concurrency=2 --filter @shop/core --filter @shop/web`:
    core 1522, web 328.
  - `pnpm exec prettier --check .`, `pnpm --filter @shop/contracts check:examples` (461 routes)
    and `pnpm guards` (15 checks, 0 failures).
  - `pnpm turbo run build --filter @shop/web && pnpm --filter @shop/e2e-admin e2e`: 50 passed.

## In progress

- Nothing.

## Next

- Merge into `storefront/mini` (orchestrator). The page streams add the host wrappers in
  `docs/mini/decor.md` §2.4.

## Notes

- Presales are full-payment only (the domain refuses a 定金 campaign), so the 预售 block shows the
  预售价 and 发货 days, not deposit / balance.
- The storefront presale list only shows campaigns inside their window, so the block's
  「距开始」 phase is only reachable in the editor canvas or a stale page; it is still handled.
