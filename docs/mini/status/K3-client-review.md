# K3 (mini client correctness review) — status

Branch `storefront/mini-K3-client-review`, worktree `/home/user/wt/K3-client-review`, from
`storefront/mini` @ f0a0b50. Brief: `docs/mini/next-tasks.md` § K3-client-review (defects where the
pieces meet: cache and badges, money, double submits, navigation, states, timers, countdowns,
login return, guest browsing, copy). Updated at every commit.

## Done

1. **我的 counts after a change elsewhere.** 我的 refetched `decor.pageUserCenter` (order badges,
   coupon / 收藏 / 足迹 totals, nickname and avatar) and the unread count on show only once they
   were stale (30 s). Paying, cancelling, confirming receipt, applying for a refund, reviewing,
   claiming or editing the profile within 30 s of the last look left the old badges. Now
   `useRefetchOnShow(key, { when: 'always' })` refetches them on every show. Tests: 我的
   (`pages/me/index.test.tsx`, with the app's 30 s staleTime), `use-refetch-on-show.test.tsx`.

2. **登录 from 确认订单, 收银台 and 支付结果 came back to 首页.** Their `LoginCard` named no
   `redirect`, so 短信验证码登录 fell back to home (`parseLoginRedirect` → `home`): the checkout
   draft, the order being paid and the payment being confirmed were left behind. They now name
   their own route (`checkout`; `cashier { orderId }`; `payResult { orderId, outTradeNo }`), and
   the login page goes back to them (A3's `loginReturn`). Tests on the three pages.

3. **A first address added from 确认订单.** The address form invalidated the address reads
   only; 确认订单 underneath (priced against the default address) stayed fresh for 30 s, still
   said 「请先添加收货地址」 and 提交订单 opened the sheet again. `ADDRESS_READS`
   (`data/stale-reads.ts`) adds `order.checkoutPreview`; 收货地址 uses it too. Test:
   `address-edit/index.test.tsx`.
4. **A claimed coupon elsewhere.** `coupon.claim` (领券中心, 商品详情 领券, the decor 优惠券 block)
   dropped the coupon lists and the wallet only: 首页 / 微页面 kept 「领取」 for as long as they
   stayed mounted (首页 never refetched on show), 我的 kept the old coupon total, and the cart's
   hint missed the new coupon. `features/coupon/use-claim.ts` `useClaimCoupon` is now the one
   claim mutation: `COUPON_READS` (+ `coupon.applicableList`) and `markStale` on the decorated
   pages (no fetch while hidden). 首页 and 微页面 fetch a copy a change marked stale when shown
   (`useRefetchOnShow(key, { when: 'invalidated' })`, so an unchanged 首页 is not refetched every
   30 s). Tests: 领券中心, 首页, `use-refetch-on-show.test.tsx`.
5. **Smaller invalidation gaps**, each with a test:
   - 取消订单 puts the coupon back (`coupon.release`): `coupon.myList` is dropped too.
   - 提交订单 takes the coupon out of the wallet: `coupon.myList` is dropped too.
   - 支付成功 drops `groupbuy.groupDetail` / `groupbuy.myGroups` (the seat is taken) with the
     order reads.
   - 商品详情 收藏 / 取消收藏 drop `catalog.favoriteList` (我的收藏 may be under the page).
   - 评价 drops `catalog.productReviews` / `catalog.productReviewSummary` too: a published
     review shows on 商品评价 and 商品详情 at once.
   - 搜索 asks for the history on every visit (`refetchOnMount: 'always'`): the last search added
     to it on the server, and the 30 s cache showed the list without it.

6. **Countdown kept ticking after zero.** `ui/countdown.tsx`'s interval ran for as long as the
   component lived, re-rendering 「已结束」 every second (every unpaid card in 我的订单 once its
   window closed), and a deadline that moved did not arm `onEnd` again. It now clears the
   interval at zero, never starts one for a deadline already past, and re-arms on a new
   `endsAt`. Tests in `countdown.test.tsx`.

7. **Copy.**
   - A refused claim reads the same everywhere: 商品详情 领券 and the decor 优惠券 block now word
     it as 领券中心 does (`claimFailureText` in `features/coupon/use-claim.ts`, over
     `claimErrorText`).
   - 收货地址 导入微信地址 toasts 「已导入微信地址」, as 确认订单 does (旧 「已导入」).
   - 申请开票 with an unknown order: 「没有找到这个订单」, as the order pages say (旧 「订单不存在」).
   - 注销账号 result: 「回到首页」, as the error states and 建设中 say (旧 「返回首页」); the
     `account.spec.ts` step follows.

8. **A second copy of 订单详情 on the stack after paying.** 订单详情 → 去支付 → 收银台 → 支付结果
   (replacing 收银台) → 查看订单 did `redirectTo(订单详情)`, leaving `[订单详情, 订单详情]`; 收银台's
   own 查看订单 did the same. `platform/nav.ts` `leaveFor(target)` (A3's `loginReturn` rule, now
   also behind `returnFromLogin`) goes back when the page underneath is that order, else replaces
   as before. 评价's 返回订单 likewise. Tests on 收银台, 支付结果 and 评价.

9. **A 404 waited for a second request.** The query client retried every failed read once,
   so 商品已下架 / 没有找到这个订单 / 页面不存在 appeared only after a second 404 and the retry
   delay (~1 s). `data/query-client.ts` `retryRead` retries a network failure or a 5xx once and
   no 4xx. Test in `query-client.test.ts`.

## In progress

- Nothing; reported.

## Pending

- The write-ups below, for a decision.

## Checked, no defect found

- **Money:** every client-side sum or split is in integer cents (`lib/money.ts`,
  `features/cart/cart-view.ts`, `lib/order-price.ts`, the refund estimate); `Price` splits the
  string, never parses a float. The few `Number(...)` uses compare with 0 or order two prices.
- **Idempotency and double submits:** 提交订单 sends one key per 确认订单 page (kept across an
  `ORDER_PRICE_CHANGED` retry; the server's replay returns the first order). Order, refund,
  review, address, invoice and claim writes are guarded by an in-flight ref or a `loading`
  (inert) button.
- **Navigation:** no hand-built paths outside `platform/`; `navigate` switches tabs with
  `switchTab`, and redirects instead of pushing at 10 pages; 确认订单 → 收银台 → 支付结果 → 订单详情
  replace each other; 售后申请, 申请开票 and 搜索 replace too.
- **States:** every list goes through `InfiniteList` (skeleton, empty, `ErrorBlock` with
  重新加载, 加载失败，点击重试); every other read on a page has an `ErrorBlock` with `onRetry`.
- **Countdowns and phases** read `serverNow()` (`Countdown`, 拼团 / 预售 phases, the decor host,
  the 开屏 day).
- **Timers and listeners:** all cleared on unmount (SMS countdown, 开屏, debounce, poll limit,
  receipt grace, overlays, poster); `Countdown` was the one leak (item 6).
- **Guest browsing:** every `auth: user` read outside a `LoginCard` is `enabled: signedIn`
  (cart, cart count, search history, unread count); the rest sit inside `LoginCard`/`LoginGate`.
  Every other login gate names its page as the redirect.

## Written up, not changed

1. **A double tap on a link opens the page twice.** 结算, 立即购买 or any card tapped twice
   before the first `navigateTo` lands pushes two copies (two 确认订单 with the same draft; the
   second shows 「没有待结算的商品」 after the first submits, so no double order). A guard in
   `platform/nav.ts` `navigate` (the same URL pushed again within ~800 ms is dropped) would cover
   every link, but touches every navigation and the unit fakes' timing: left for a decision, with
   the full mini unit suite and `test:mini` to run after it.
2. **Duplicate money helpers.** `features/cart/cart-view.ts` `centsOf` / `moneyFromCents` repeat
   `lib/money.ts` `toCents` / `fromCents` (the cart's maps a malformed string to 0, lib's to
   `NaN`). Cleanup: one module.
3. **`aftersale/apply` keeps its own `REFUND_READS`** (without `refund.myDetail`, harmless for a
   new request) beside `aftersale/shared/actions.ts`'s. Cleanup.
4. **收银台 opened after the pay window closed** but before the auto-cancel job ran shows
   「已结束」 with 微信支付 still active; the tap gets `PAYMENT_ORDER_EXPIRED` and then 「订单已关闭」.
   Harmless; could check `payExpiresAt` against `serverNow()` on render.
5. **`ErrorBlock`'s 登录 state has no button** unless the page passes `onLogin`, and none does.
   Pages rely on `LoginCard`, so it only shows if a 401 escapes the session's renewal.

## Page-form changes (旧 → 新)

- 我的: the order badges and totals are current every time the tab is shown (旧 up to 30 s old
  after a change made on another page).
- 确认订单 / 收银台 / 支付结果: signing in by SMS on the page comes back to the page (旧 to 首页,
  losing the draft).
- 首页 / 微页面 / 我的: a coupon claimed on another page shows as claimed when the shopper comes
  back (旧 「领取」 until the page was pulled down or reopened).
- 确认订单: back from adding the first address, the address is there (旧 「请先添加收货地址」
  for up to 30 s).
- 搜索: the history includes the last search (旧 up to 30 s behind).
- 商品详情 领券 / 装修页 优惠券 block, a refused claim: 「来晚了，券已抢光」, 「已达领取上限」,
  「不在领取时间内」, 「这张券暂不可领取」 as on 领券中心 (旧 the server's words, e.g.
  「该优惠券已被领完」, 「您已领取过该优惠券」).
- 收货地址: 「已导入微信地址」 (旧 「已导入」). 申请开票: 「没有找到这个订单」 (旧 「订单不存在」).
  注销账号 result: 「回到首页」 (旧 「返回首页」).
- 收银台 / 支付结果 查看订单 and 评价 返回订单, when opened from that 订单详情: back to it (旧 a
  new copy of it on top; 返回 then showed the same order again).
- 商品已下架 / 没有找到这个订单 / 页面不存在 show at once (旧 after a second request, ~1 s).

## Backend gaps

- None so far.

## Open questions

- 我的 now asks for `decor.pageUserCenter` and the unread count on every show of the tab (as the
  uni-app's `onShow` did): one request pair per visit. Fine, or only when marked stale?
- The copy changes above (refused-claim wording, 回到首页) follow 领券中心 and the error states;
  say if the other wording should win instead.

## Tests for the orchestrator to run

- `e2e/storefront/specs-mini/account.spec.ts`: the 注销 journey clicks 「回到首页」 now (edited).
- The rest of `pnpm --filter @shop/e2e-storefront test:mini` once, since shared behaviour moved:
  `orders.spec.ts` (评价 返回订单 now goes back), `shop-journey.spec.ts` (支付结果 查看订单),
  `promo.spec.ts`, `coupons.spec.ts`, `decor.spec.ts`, `user-center.spec.ts` (claims mark the
  decorated pages stale; 我的 refetches on show), `new-shopper-buys.spec.ts` (address → 确认订单).
- Run here (targeted, `--maxWorkers=2`): the unit tests of every changed directory, 65 files,
  344 tests, green; `pnpm --filter @shop/mini typecheck` and `lint` clean; `pnpm guards` 15/15;
  `prettier --check` on the changed files clean.
