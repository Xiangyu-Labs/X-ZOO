# J2 (product + decor host) — status

Branch `storefront/mini-J2-product-decor`, worktree `/home/xiangyu/Projects/x-zoo-mini-wt/J2-product-decor`,
based on `storefront/mini` @ 2d7936c9f.
Brief: the shopping pages pick up H4's filters and switches (A), a product-poster switch (B),
and the DecorPage host wrappers from decor.md §2.4 (C).

## Done

### A. Shopping pages catch up with H4

- 商品详情 activities: `groupbuy.list` / `presale.list` are called with `{ productId, pageSize: 1 }`.
  The `canBuy` filter stays.
- 商品详情 领券: `coupon.claimableList { productId }`. The client no longer filters to `all_products`,
  because the server narrows the list (COUPON-009).
- 商品列表: `couponId` goes through to `catalog.productList`, and the "cannot narrow" note is removed.
  我的优惠券 and 领券中心「去使用」 already passed the template id.
- `display` switches, each read as `?? true` through `displayOf` / `useDisplay` in `app-config`:
  - 分类 subcategories (`categorySubcategories`);
  - 商品详情 评价, 推荐 and 服务 (`productReviews`, `productRecommendations`, `productServiceTags`).
- 确认订单 presale note: taken from `preview.shipAfterDays`. The `presale.detail` call is removed.
- `shopping.spec.ts`: the top of 商品详情 shows ¥59, the low end of the ¥59–¥65 range
  (e2e-coverage §4 item 5).

### B. Product poster switch

- `display.productPoster` is added to `storefront-appearance`: 「允许生成商品海报」, 页面显示, default on.
- `app/config` returns it, and the example is updated.
- 商品详情 hides 生成海报 and the poster host when it is off; 分享给好友 stays. The 拼团 poster is untouched.
- Tests, all under SYS-015: contracts default, core int, web int over HTTP, and the mini share sheet.

### C. DecorPage host (`features/decor/decor-host.tsx`)

- `useDecorHost(route, reload)` passes `host` (`signedIn`, `serverNow`, `overlayOpen` from the
  overlay store) and `personal`.
- `onIntent`:
  - `login` / `claimNewcomerCoupons` → `requireLogin`, then reload when signed in on the spot.
  - `claimCoupon` → login gate → `coupon.claim` → toast → reload. The button is never flipped
    locally (DECOR-015), and a double tap claims once.
  - `contact` → call the hotline, or do nothing.
- `useDecorRenderIntent`:
  - contact → the WeChat contact button, a phone wrapper, or `null` when there is no 客服;
  - `officialAccount` → `officialAccountBar()` in `platform/`: `<OfficialAccount/>` on weapp, `null` elsewhere.
- 首页, 我的 and 微页面 pass `reload`. The demo page reuses `useDecorRenderIntent`.
- The splash overlay counts as an open overlay.
- Unit tests: `features/decor/decor-host.test.tsx`.
- e2e: `decor.spec.ts::DECOR-015: a visitor claims from the 首页 优惠券 block after signing up, and the reloaded page says 去使用`.
- Production weapp excludes the demo subpackage (`app.config.ts` `withDemo`). Verified in `dist/weapp`, see the report.

## Page-form changes

1. 商品列表 from 去使用: the list is narrowed to the coupon's products. The note 「优惠券的适用范围以结算页为准…」 is removed.
2. 商品详情 领券: the list now includes product-scoped and category-scoped coupons, not only shop-wide ones.
3. 装修页 联系客服 when the shop has no 客服:
   - 服务宫格: the cell is empty;
   - 悬浮客服: hidden;
   - previously, a toast 「暂未开通在线客服」.
4. 开屏浮层 open: page scroll is locked, and a 视频 block shows its poster.
5. The 页面显示 switches can now hide 评价, 推荐, 服务, 生成海报 and 二级类目. All are shown by default.
6. Admin: a new switch, 「允许生成商品海报」.

## Backend gaps

None new.

## Open questions

- A guest who taps 领取 is sent to log in, returns to the page, and taps 领取 again. The claim is
  not made automatically after login. This matches the other login gates and decor.md §2.4.
