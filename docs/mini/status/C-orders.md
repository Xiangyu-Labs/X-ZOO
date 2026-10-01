# Stream C: order and after-sales pages (status)

Branch `storefront/mini-C-orders` (from `storefront/mini`). Scope: `packages/order/{list,detail,
logistics,review}`, `packages/aftersale/*`, `platform/receipt.ts`, `ui/timeline.tsx`, and the
order/after-sales specs in `e2e/storefront/specs-mini`.

## Done

- `platform.openOrderConfirm` (WeChat's 确认收货 component, C07) in all three builds; the
  emulated one answers by `EmulatedWechatUser.receipt` (default `confirm`).
- `platform/receipt.ts` `confirmReceipt(client, orderId)`: the one caller of
  `order.confirmReceipt`. Asks `payment.wechatReceipt` (H2, merged); a receipt opens WeChat's
  component then posts `{ via: 'wechat-component' }`, `null` gets the plain dialog.
- e2e harness `mini/confirm-receipt`: the emulated component marks the payment confirmed on
  the fake `api.weixin.qq.com` (`order_state` 3), which the server reads via `get_order`.
- `ui/timeline.tsx` (物流轨迹, 售后进度).
- 我的订单 (tabs + counts, paged list, all card actions) with tests.
- 订单详情 (by id or outTradeNo; status header + countdown, parcels, address, lines, 金额明细,
  facts + copy, 发票, ActionBar with 客服) with tests.
- 物流 (tab per parcel, trail timeline, copy number, merchant/virtual delivery) with tests.
- 评价 (a card per reviewable line, 服务评分 once, images; `moderation: 'pending'` → 「评价已提交，审核后展示」; already-written lines count as done) with tests.
- 售后 apply (lines + quantities, 仅退款/退货退款 only when shipped, reason sheet, estimate incl. freight on a whole unshipped refund, words, 6 pictures, subscribe('refundApply') in the tap) with tests.
- 我的售后 (one list for every order; 全部/处理中/已退款/已关闭) with tests.
- 售后详情 (status + note, return address + copy, 退货物流, 售后进度 timeline, facts, 撤销/删除/填写退货物流) with tests.
- 填写退货物流 (寄回地址 + copy, courier picker from `GET /api/v1/express-companies` with search, first 30 listed; waybill cleaned of spaces; optional phone; subscribe('returnShipment') in the tap) with tests.
- E2E (`e2e/storefront/specs-mini/orders.spec.ts`, `aftersale.spec.ts`; page objects in
  `src/mini-pages/{order-pages,aftersale-pages,order-shopper,shown}.ts`): pay from 待付款 →
  待发货 → admin ships (admin API) → 物流 → 确认收货 via WeChat's component → review held
  for moderation; cancel unpaid; refund → admin approves → 退款成功; return waybill. Green.
  The e2e seed now gives 顺丰/中通 their WeChat delivery codes (the upload needs them).
- docs/mini/pages.md updated for the pages as built (form changes listed up top).
- 375px H5 screenshots in `docs/mini/status/C-screens/` (seeded e2e data; product images are
  blank because the e2e stack is offline). Taken with a throwaway spec against a warm stack and
  `FONTCONFIG_FILE` pointing at a CJK font.
- Merged storefront/mini with H2, then again with G1.

- Merged storefront/mini again (F2 + H3); pages.md conflict resolved to the real route ids.
- `apps/mini/scripts/size-report.mjs`: the AppSecret-shaped token check skips Taro's hashed
  `sub-common/<32 hex>` chunk names (it failed every order/aftersale page once they shared code).

## In progress

- Nothing; checklist run for the final report.

## Next / open

- Backend gaps: `order.detail` has no group-buy team id (no 查看拼团 link); no per-line
  "reviewed" flag (the review page counts CATALOG_REVIEW_ALREADY_WRITTEN as done); the
  express-company picker gets all ~1100 companies in one answer (search is client-side).
- Not done: C07's `App.onShow` `referrerInfo.extraData` fallback for the receipt component;
  gift coupons (`coupon.orderGiftCoupons`) on the order detail.
- B's pay-result page does not invalidate `order.*` reads after paying (the detail pages now
  refetch on mount, which covers this stream's pages).
- The e2e seed's express companies now carry WeChat delivery codes; the upload refuses without.
