# H4 (backend follow-ups, contract owner) — status

Branch `storefront/mini-H4-backend`, worktree `/home/xiangyu/Projects/x-zoo-mini-wt/H4-backend`.
Brief: read-side additions for the order/after-sales pages (stream C's "Backend gaps"): the
拼团 team id on the order detail → per-line review state → 待评价 count → express-company
search → the rest of C's gaps → merge checklist.

## Done

1. `order.detail` (and every answer shaped like it: `order.create`, `order.cancel`,
   `order.confirmReceipt`) carries `groupbuyTeamId: id | null`, the team the order opened or
   joined. Read through a new optional `OrderKindHandler.detailLinks(db, orderId)` port method
   (group buy answers from its membership row), so the order domain still never reads a
   `groupbuy_*` table. ORDER-011.

2. Per-line review state on the shopper's own lines: `order.list` and `order.detail` items are
   now `storefrontOrderItem` = `orderItem` + `reviewed` (any review row: published, 待审核, or
   removed by the shop — each makes a second one `CATALOG_REVIEW_ALREADY_WRITTEN`) +
   `reviewable` (exactly what `catalog.reviewSubmit` accepts: order `received`/`completed`,
   line not refunded in full, not reviewed). The console keeps the plain `orderItem`
   (`adminOrderListItem` extends the unchanged `orderListItem`). ORDER-010.

3. 待评价. **Definition:** a live order of the shopper's (not hidden, not deleted) in
   `received` or `completed` with at least one `reviewable` line (item 2). There is no review
   deadline to check: the auto-review job writes the default review `autoReviewDays` (default 7) after completion, and that is what takes a line out; until it runs the shopper can still
   write one, so the count keeps it. A subset of 已完成 (`finished`).
   - `order.counts` gains `unreviewed` (same grouped query, `count(*) filter (where …)`).
   - `order.list` gains `tab: 'unreviewed'` (so `orderList { tab: 'unreviewed' }` is a valid
     route too), the same SQL predicate as the count (`repo.awaitingReview`).
   - Decor 订单入口: `orderEntryCountsFor` now fills `unreviewed`; the schema field stays
     optional (older server → no badge). DECOR-015 test updated.
   - ORDER-010 extended (count, tab, auto-review).

4. `GET /api/v1/express-companies` (`shipping.expressCompanyOptions`) takes
   `?keyword=&limit=` (`expressCompanyOptionsQuery`): enabled only, a WeChat courier code
   (`wechatDeliveryId`) first, then `sortOrder DESC, id ASC`; `keyword` (≤ 50, trimmed, blank =
   none) matches name or code with `ILIKE`, `%`/`_` literal; `limit` 1–100, **default 50**.
   The only caller of this path is the mini's 填写退货物流 page (the uni-app's staff console
   reads `/api/v1/staff/express-companies`, and the console `/admin-api/express-companies`;
   both unchanged and uncapped), so the no-parameter answer is now the first 50, not all
   ~1100. Response body unchanged. SHIP-003.

5. The rest of C's "Backend gaps": there were exactly the three above. C's other open items
   are client-side and need no backend: gift coupons (`coupon.orderGiftCoupons`,
   `GET /api/v1/orders/:id/gift-coupons`, already exists), the C07 `referrerInfo` fallback,
   and B's pay-result invalidation. Docs: pages.md §2.3 note and §5 rows, decor.md 角标 note.

6. Stream B's gaps (added mid-task by the coordinator), all read-side:
   - (a) `groupbuy.list` and `presale.list` take `?productId=`: that product's live activities
     only (the same visibility window as the unfiltered list). No new route: 商品详情 asks
     each list with `pageSize: 1`.
   - (b) `coupon.claimableList` takes `?productId=`: among the claimable templates, the
     shop-wide ones, those naming the product, and those naming a category it is filed under
     (its direct `product_categories_map` rows, the ones the checkout reads). SQL twin of
     `eligibleLineIndexes`. COUPON-009.
   - (c) `catalog.productList` takes `?couponId=` — a coupon **template** id
     (`userCoupon.templateId`, `claimableCoupon.templateId`), not the wallet row id. Shop-wide:
     every sellable product; 指定商品: those; 品类券: the products under its categories. An
     unknown or draft template lists nothing; a disabled or deleted one still answers (its
     coupons stay spendable). The scope comes from the coupon domain's new `productScope`
     (catalog → coupon, the existing import direction). COUPON-009 (both lists agree with what
     `coupon.listApplicable` covers).
   - (d) `GET /api/v1/app/config` gains `display { categorySubcategories, productReviews,
productRecommendations, productServiceTags }`, from four switches on the
     `storefront-appearance` group (小程序外观 → 页面显示). All default `true` (what the pages
     show today). Config fields with defaults: no migration. SYS-015 extended.
   - (e) `order.checkoutPreview` gains `shipAfterDays: number | null`: the presale campaign's
     days after full payment (the column `handlePaid` stamps `ship_not_before_at` from), `null`
     for any other kind. Through a new optional `OrderKindHandler.previewTerms` port method.

## Checklist (after item 6 and the merge of storefront/mini with stream D)

All green: `pnpm turbo run gen typecheck lint test:unit build` (45/45); `test:int --force
--concurrency=2` (core 1521, web 324, worker 6, testing 9); `prettier --check .`;
`check:examples` (461 routes); `pnpm guards` (15 checks, 0 failures); uni-app `npm ci` +
`npm test` (477 passed, 32 skipped); `test:mini` (15 passed).

Not done (not assigned): D's 「允许生成商品海报」 switch would be one more `display` field.

## Client follow-ups

- 订单详情: 查看拼团 → `{ route: 'groupbuyTeam', params: { id: order.groupbuyTeamId } }` when
  `groupbuyTeamId !== null`.
- 评价 page: `reviewableLines` → `order.items.filter((item) => item.reviewable && …)`; lines with
  `reviewed` can show as done up front; keep treating `CATALOG_REVIEW_ALREADY_WRITTEN` as done
  (a race with another device). 我的订单 card: show 评价 only when some line is `reviewable`.
- 我的订单: `ShownTab` now also excludes `unreviewed`, which keeps the build green; to show a
  待评价 tab add it to `ORDER_TABS` (`counted: true`) and `EMPTY_TEXT` and drop it from the
  `Exclude`. Badge: `counts.unreviewed`.
- 订单入口 (`packages/storefront-blocks/.../order-entry.tsx` `orderEntryLink`, and the comment
  on `ORDER_ENTRY_KEYS`): `unreviewed` still opens `myReviews` (reviews already written) while
  its badge now counts orders still to review; once 我的订单 has the tab, point it at
  `{ route: 'orderList', params: { tab: 'unreviewed' } }` (and `user-center.test.tsx`).
- **填写退货物流 (needed):** the page still searches client-side over what the server sent,
  which is now the first 50; a carrier past those is not found until the search goes to the
  server: `useRouteQuery('shipping.expressCompanyOptions', { query: { keyword, limit: 30 } })`
  with a debounced keyword, and drop `PICKER_LIMIT` / the local filter. 顺丰/中通 (WeChat codes
  in the e2e seed) come first either way.
- Test fixtures: `apps/mini/src/test/order-fixtures.ts` items default to
  `reviewed: false, reviewable: false`, details to `groupbuyTeamId: null`.
- 商品详情 拼团 / 预售 bars (`features/product/activities.ts`): replace the two
  `pageSize: 100` reads and the local filter with
  `useRouteQuery('groupbuy.list', { query: { productId, pageSize: 1 } })` (and the same for
  `presale.list`); keep the `canBuy` check.
- 商品详情 领券 row (`features/product/product-coupons.tsx`): pass `productId` to
  `coupon.claimableList`.
- 商品列表 (`packages/goods/list`): pass `couponId` through to `catalog.productList` and drop
  the "cannot narrow" note; whoever links 我的优惠券「去使用」 must pass the coupon's
  **`templateId`**, not its `id`.
- 分类 (`features/catalog/category-tree.ts` `showsSubcategories`) → `config.display.categorySubcategories`;
  商品详情 评价 / 为你推荐 / 服务 → `display.productReviews` / `productRecommendations` /
  `productServiceTags`. Read them as `config.display?.x ?? true` if a cached payload from an
  older server can reach the page. Fixture: `apps/mini/src/test/app-config-fixture.ts` has
  `display` all `true`.
- 确认订单: `preview.shipAfterDays` replaces the `presale.detail` read for the presale note
  (`checkout-fixture.ts` defaults it to `null`).
