# H5 — backend follow-ups (status)

Worktree `x-zoo-mini-wt/H5-backend`, branch `storefront/mini-H5-backend` (from `storefront/mini`
@ 2d7936c9f). Updated at every commit so the work can resume after an interruption.

## Done

- **Empty 发货 / 确认收货 messages** (NOTIF-007). The order domain's fulfilment handler reads the
  order (`orderNo`, paid amount) and the parcel (carrier, tracking number, courier) when it runs
  and hands them to the notifier (`FulfilmentNotice.order` / `.shipment`); the effect rows keep
  their ids-only payload, so rows already in the ledger are told in full. `order_shipped` is
  keyed per parcel (a split shipment tells each parcel), has a `deliveryInfo` variable that
  reads right for 快递 / 商家配送 / 虚拟发货, and the default wording uses it; a parcel cancelled
  before the send is not announced. Same class: 退款到账 lacked `refundNo`
  (`OrderRefundedEvent.refundNo`, optional), 支付成功 lacked `paidAt`. A unit test checks every
  event's wording against its declared variables; fan-out logs a placeholder that rendered blank.

- **Picked activities in the service.** `groupbuy.list` / `presale.list` take the `ids` branch
  (`cardsFor`, then page); the two `api/v1/*/activities` routes are one-line binders. `ids` with
  `productId` is their intersection (documented on the contract fields, tested in
  `picked-lists.int.test.ts`).
- **Decor editor off legacy DIY.** The record pickers moved to `src/admin/decor`
  (`record-types`, `catalog-records`, `record-kinds`); `admin/diy` keeps thin adapters over them.
  ESLint `NO_LEGACY_DIY` forbids `admin/decor` and the decor pages importing `admin/diy`.
  `docs/mini/cutover.md` §2.3 lists the files the cutover deletes.
- **Web unit tests under contention.** Measured: alone, the named tests take 0.1–4.4 s; a CPU
  profile of 拼团活动 showed ~40 % of the worker in `*ByRole` → happy-dom `getComputedStyle`
  matching antd's injected stylesheets against every ancestor. `renderAdmin` now puts antd's
  styles in a detached node. Same load, back to back: summed test time 172 s → 109 s, wall
  86.7 s → 76.4 s (CPU user 378 s → 338 s); 拼团活动 edit 4.4 → 1.0 s, 装修列表 designate
  3.5 → 0.5 s, 商品编辑器 shipping 4.4 → 1.9 s. Workers stay at 4 (A2's finding holds: the
  load is external). What remains is per-file import of antd (~40 % of the run).

## In progress

- Merge checklist.

## Pending

- none

## Page-form changes

- 发货 in-app message default wording: 「订单 X 已由 {company} 发出，运单号 {trackingNo}。」 →
  「订单 X 已发货，{deliveryInfo}。」 (express: 「顺丰速运 运单号 SF…」; 商家配送: 「由商家配送，配送员 …」;
  虚拟: 「虚拟商品已发放，可在订单详情中查看」). A template already saved in 通知管理 keeps its stored wording (express reads right there too; 商家配送 / 虚拟 now fill `company` so only 「运单号 」 stays blank).

## Backend gaps

- `admin_order_received` (用户确认收货提醒) and `order_unpaid_reminder` (未付款提醒, the
  `order.remindUnpaid` job) are sent now, and `nickname` is no longer declared on any event.
- The reference seed's template shells list variables (`expressName`, `productName`) the
  registry does not; the admin form shows the registry's list, so this is cosmetic.

## Open questions

- Nothing antd hides only through a class is hidden in unit tests any more (see `src/test/render.tsx`). No test relied on it; flagging for whoever writes a visibility test.
