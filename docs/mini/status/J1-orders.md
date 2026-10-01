# J1 (order side catches up with H4) — status

Branch `storefront/mini-J1-orders`, worktree `/home/xiangyu/Projects/x-zoo-mini-wt/J1-orders`,
from `storefront/mini` @ 2d7936c9f. Brief: H4's "Client follow-ups" for the order pages, the
presale price defect, 我的评价 status, the receipt foreground fallback.

## Done

1. Presale / 拼团 price on 订单详情 and 我的订单: `lib/order-price.ts` (`orderPrices`) reads each
   line's `adjustments`; the line prints at the activity price, 商品金额 after the activity,
   优惠券 the coupon alone (as the uni-app). Older lines without adjustments: the uni-app's
   fallback (single-line activity order, `userCouponId === null`). `lib/money.ts` now holds
   `toCents`/`fromCents` (aftersale re-exports them). `coupons.spec.ts`'s `test.fail` removed,
   e2e-coverage.md rows updated. 确认订单 (J2's) itemises the activity as its own row and 支付结果 /
   收银台 show no line prices: nothing to fix there.
2. 订单详情: 拼团 → 查看拼团 cell (`groupbuyTeam { id: groupbuyTeamId }`) when non-null.
3. 评价 page shows `reviewable` lines to write and `reviewed` lines as done up front;
   `CATALOG_REVIEW_ALREADY_WRITTEN` still counts as done. 去评价 only while a line is
   `reviewable` (received or completed). `OrderCard` / `orderActions` take storefront lines.
4. 我的订单 待评价 tab (`counts.unreviewed` badge).
5. 订单入口 `unreviewed` → `orderList { tab: 'unreviewed' }` (block, `ORDER_ENTRY_KEYS`
   comment, `user-center.test.tsx`, decor.md 角标 note).
6. 填写退货物流: server search (`keyword` debounced 300 ms, `limit: 30`), fetched when the sheet
   opens; `PICKER_LIMIT` / `matchCompanies` gone. Unit tests assert the requests.
7. 我的评价 status: already delivered by stream E (fc28c351f: `status` on `catalog.myReviews`,
   service read, badges 「审核后展示」/「仅自己可见」). Added a `held-and-hidden` contract example
   (parses) and the hidden badge to the page test. Copy kept (see Open questions).
8. Receipt foreground fallback (C07): `platform/receipt.ts` listens to `onAppShow`
   (`platform/lifecycle.ts` `onAppShown`) only while the component is open;
   `referrerInfo.extraData.status` settles it, a bare return waits `RETURN_GRACE_MS` (1.5 s)
   then posts `{ via: 'wechat-component' }` (server checks `get_order`); a refusal then is the
   quiet outcome `returned`, and `useOrderActions` re-reads the order. Unit tests (receipt,
   订单详情), Taro fake gained `showApp(options)` and `businessViewStatus: 'hang'`; the emulation
   gained `receipt: 'confirm-silently'` (+ the e2e type), and `orders.spec.ts` a journey for it.
9. Docs: pages.md rows (我的订单, 订单详情, 评价, 填写退货物流), wechat-compliance.md C07 client note.

## Checklist (2026-09-24, all green)

`prettier --check .`; `turbo run typecheck lint build` (exit 0); `turbo run test:unit
--concurrency=2` (16/16); `pnpm guards` (15 checks, 0 failures); `check:examples` (461 routes);
`@shop/contracts test:int` (pass); `test:mini` 38 passed (incl. the former `test.fail` and the
new receipt-fallback journey).

## In progress

- Nothing; reported.

## Page-form changes (旧 → 新)

- 订单详情 / 我的订单: an activity line prints at the price paid (旧 catalogue price and the
  activity lumped into 优惠券).
- 订单详情: a 拼团 order has a 「拼团 · 查看拼团」 row under the status header (旧 none).
- 我的订单 card status: a received or completed order reads 待评价 while a line can still be
  reviewed, else 已完成 (旧 received = 待评价 always, completed = 已完成 always). 去评价 follows
  the same rule, so a completed order inside the review window also gets it.
- 订单详情 received note: 「感谢购买」 once nothing is left to review (旧 always 「…欢迎评价」).
- 评价 page: lines already reviewed show as 「已评价」 up front; everything reviewed → 「已经评价过了」
  result page (旧 the form, refused line by line on submit).
- 我的订单: a 待评价 tab between 待收货 and 已完成, with a count (旧 none; 已完成 covered it).
- 个人中心 订单入口 待评价 opens 我的订单's 待评价 tab (旧 我的评价).
- 填写退货物流: the courier list comes from a server search as the shopper types (旧 one list of
  everything, filtered on the phone). Same sheet, same 30 shown.

## Backend gaps

- None so far.

## Open questions

- 我的评价 badge copy: the brief says 审核中 / 已隐藏; E shipped 「审核后展示」 / 「仅自己可见」 (same
  words as the 评价 page's 「评价已提交，审核后展示」, and 仅自己可见 does not say the shop took it
  down). Kept E's; a one-line change in `REVIEW_STATE_TEXT` if the user prefers the brief's.
