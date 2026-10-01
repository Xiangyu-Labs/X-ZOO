# Stream E — account and content pages (status)

Worktree `x-zoo-mini-wt/E-account`, branch `storefront/mini-E-account` (from `storefront/mini`).
Updated at every commit so the work can resume after an interruption.

## Done

- Orientation: contracts, UI kit, session, platform seam, B's `DecorPage` (not merged yet).
- `catalog.myReviews` gains `status` (additive contract fix, for 我的评价's 待审核).
- `platform/invoice-title{,.h5}.ts` + `invoice-title-map.ts` (`chooseInvoiceTitle`, 模拟小程序
  answers the harness's `invoiceTitle`); the Taro fake gained `chooseInvoiceTitle`.
- `features/checkout/address-choice.ts` (the address picked in select mode).
- `packages/account/shared` (SubmitBar, error helpers, SMS, password rules), `src/test/account-fixture.ts`.
- 个人资料 (chooseAvatar + nickname input, C09 field error), 设置, 手机号 (bind WeChat / SMS,
  change by SMS), 修改密码 (old password or SMS; silent re-sign-in), 找回密码. Tests.
- 收货地址 (导入微信地址: saved in one tap when the region resolves against the city tree,
  else handed to the form; select mode writes `address-choice` and goes back; 默认, 编辑,
  删除) and 新增 / 编辑地址 (RegionPicker, import, 默认). S4's checkout (stream B's page) got a
  minimal hook: tapping the address opens select mode, the preview/create body sends
  `addressId`. Tests.

- 我的收藏 / 浏览记录 (管理 mode, batch 取消收藏 / 删除, 清空; history grouped by day) and 我的评价
  (stars, pictures, reply; 待审核 as a neutral 「审核后展示」). Tests.
- 消息中心 (a `data.route` opens that page and marks read; else 消息详情; 全部已读; 删除) and
  消息详情 (marks read once shown; 查看详情 when routed; 删除). Tests.

- 发票 (tabs 发票抬头 / 开票记录; 设为默认, 删除, cap of 20), 新增 / 编辑发票抬头 (从微信导入,
  企业 / 个人, 专票 fields, C09 name error), 发票详情 (撤回, 重新申请, 未通过的原因), 申请开票
  (default title first, 新增抬头 comes back picked, remark; `invoiceRequestFromTitle` copied
  locally). Tests.

- Merged storefront/mini (C + A2) at `71c60b452`: kept both sides of the Taro fake.
- 协议 (`pages/agreement`: key → title, operator HTML through the DIY 富文本 renderer
  `features/content/rich-content.tsx`, 「内容整理中」 when empty, WeChat's 隐私保护指引 on
  隐私政策) and 注销账号 (what it does, the 注销协议, reason, tick + danger confirm → request →
  logout → result; pending shows 审核中 + 撤回; a rejected one says why). The Taro fake gained
  `RichText` and `WebView`. Password rule gained the server's two-kinds check. Tests.

- content: 资讯 (全部 + top-level category tabs, a category includes its children via
  `categoryIds`; share 好友), 资讯详情 (rich text, linked product, 「相关链接」 lists the
  `<a href>`s that `rich-text` cannot tap plus 阅读原文, all through `openExternalLink`; share
  好友 + 朋友圈), 网页 (业务域名 → `<WebView>`; else a sheet 「该链接需在浏览器中打开」 with
  复制链接). Tests.

- 我的 tab (`decor.pageUserCenter` through `features/decor-lite/decor-page.tsx`, a minimal
  renderer with B's `{ page, route }` interface: links via `openLinkTarget`, `login` →
  `requireLogin(me)`, 客服 as WeChat's contact button / call / note; refetch on sign-in, on show,
  on pull-down; 「N 条未读消息」 row). **Swap to B's `features/decor/decor-page.tsx` and delete
  `features/decor-lite/` once B merges.** Tests.

- e2e `specs-mini/account.spec.ts` (7 tests): risky nickname → field error; address add / edit /
  pick at checkout / delete; 收藏 list (favourite arranged via API, the button is B's product
  page); a 支付成功 message opens its order; invoice title imported from WeChat; 我的评价 shows a
  held review; 注销 signs out (token dead on the server too). `EmulatedWechatUser` (app and e2e)
  now types `invoiceTitle`.
- `docs/mini/pages.md` form changes for the E pages.

- Merged storefront/mini after B: 我的 now draws with B's `features/decor/DecorPage` under a
  custom `NavBar` (`decor-lite` removed). B's checkout picks its address in its own sheet, so
  the address book's select mode and `features/checkout/address-choice` are gone (the route
  catalogue still declares `addresses { select }`, now unused). The e2e 收藏 now taps the
  product page's 收藏; the address e2e picks the address in B's checkout sheet.

- `test:mini` after the merge: 18/18 green. 375px H5 screenshots in `E-screens/` (14 pages,
  taken with a throwaway spec on the e2e stack, `FONTCONFIG_FILE` pointing at a CJK font).

- 个人资料 renders `NicknameField` from `@/platform` (new, `platform/nickname-field.tsx`): the
  mini guard keeps `type="nickname"` inside `src/platform/`.
- Merged storefront/mini again (D merged; clean).
- Final checklist (2026-09-24): `pnpm turbo run gen typecheck lint test:unit build` pass (45/45);
  `test:mini` 22/22 (a first run lost the first test to a cold stack in C's
  `signUpFromOrders`; the rerun was green); `prettier --check .` pass; `pnpm guards` pass.
  Sizes (weapp): main 656.0 KB, account 120.1 KB, content 14.9 KB, total 1034.7 KB.

## In progress

- Nothing; final report sent.

## Next

- Nothing for E. Open: the route catalogue's `addresses { select }` is now unused.

## Backend gaps found

- 发货 / 确认收货 in-app messages render with empty variables (「订单 已由 发出，运单号 。」):
  the fulfilment notifier (`notification.effects.ts`, `registerFulfilmentNotifier`) reads
  `orderNo` / `company` / `trackingNo` from a notice payload that does not carry them. Seen in
  `E-screens/07-messages.png`. Not fixed here (core, not E's).

- `catalog.myReviews` returned no status, though the list includes 待审核 and hidden rows.
