# K1-security 状态

分支 `storefront/mini-K1-security`（自 `storefront/mini` @ f0a0b50）。审查范围：`git diff origin/master...HEAD`
里的 `apps/web/app`、`apps/web/src/admin/decor`、`packages/core`、`packages/contracts`、`apps/mini`、
`packages/storefront-blocks`、`packages/api-client`。`master` 等于线上。行号以本分支为准（master 上的另注）。

> 2026-09-24 用户确认：线上还没开始运营，只是内部测试。下面标 PRODUCTION 的只表示 `master` 上也有，
> 没有真实顾客受影响，随切换上线即可，不需要热修。

## 发现（PRODUCTION 在前）

严重度：高 = 能直接拿到钱或别人的数据；中 = 可被利用但影响有限，或合规问题；低 = 需要额外条件；信息 = 设计取舍，写下来备查。

| #   | 严重度 | 位置                                                                                                                                                      | 利用方式                                                                                                                                                                                                                                                                                                                                                                       | master 上有？                                                            | 处理                                                                                                                                                                                                                                                                                                                             |
| --- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | 高     | master `packages/core/src/order/order.checkout.service.ts:326-330`（预览和下单的 `gatherAdjustments`）、`:542`（`selections`）                            | **PRODUCTION。** 任何登录用户 `POST /api/v1/checkout/preview` / `POST /api/v1/orders`，body `{kind:'normal', source:'buy-now', item:{skuId}, kindMeta:{kind:'groupbuy' 或 'presale', activityId}}`。`kindMeta` 展开在 `kind` 之后，拼团或预售的计价器按活动价计价，订单却按普通订单走：不开团 / 参团、不占活动库存、不受活动的每单和总量限购、预售没有发货承诺。               | 是                                                                       | 本分支已修（H1 `b0f22e0`，ORDER-009）；本任务补了预售半边的测试 `50b2b08`。用户已决定不热修 master，随切换合入。**如果 ICP 通过、外网提前开放，要重新提醒用户。**                                                                                                                                                                |
| P2  | 中     | `packages/core/src/catalog/catalog.review.service.ts` `reviewSubmit`；`packages/contracts/src/catalog/schemas.ts:896`（`images` 是任意字符串）            | **PRODUCTION。** `POST /api/v1/catalog/reviews` 的 `images` 填自己服务器上的图片地址。评价公开展示：图片可在微信检测之后替换；每个打开商品页的顾客、每个打开「评价管理」的管理员的 IP / UA 都会被对方服务器记录。头像早已按 USER-019 拒绝这种地址，评价图没有。                                                                                                                | 是                                                                       | **已修** `f2913a6`（CAT-018）：每张图必须是我们存储里的在用图片，否则 `CATALOG_REVIEW_IMAGE_NOT_ALLOWED`（422，「请上传评价图片后再提交」）。两个客户端都只传上传接口返回的 URL，不受影响。master 仍存在。                                                                                                                       |
| P3  | 中     | master `packages/core/src/user/user.service.ts` `updateProfile`（`avatarUrl` 原样保存）                                                                   | **PRODUCTION。** `PUT /api/v1/profile {avatarUrl:'https://attacker/x.png'}`，头像显示在评价、拼团团页等处，效果同 P2。                                                                                                                                                                                                                                                         | 是                                                                       | 本分支已修（USER-019，`acceptedAvatar`），随切换合入，无需再改。                                                                                                                                                                                                                                                                 |
| P4  | 低     | `packages/contracts/src/refund/schemas.ts:139`（售后凭证 `images` 是任意字符串）                                                                          | **PRODUCTION。** 申请售后时凭证图填外部地址；只有顾客本人和后台看得到，管理员打开售后单时 IP / UA 泄露给对方。                                                                                                                                                                                                                                                                 | 是                                                                       | **已修**（L1 `f115494`，REFUND-014）：`refund.apply` 里每张凭证图必须是我们存储里的在用图片，否则 `REFUND_IMAGE_NOT_ALLOWED`（422，「请上传凭证图片后再提交」），在锁订单之前检查。小程序申请售后页走 `ImageUploader`，只传上传接口返回的 URL，不受影响。master 仍存在。                                                         |
| P5  | 信息   | `packages/contracts/src/groupbuy/schemas.ts:384-391`（`groupbuy.groupDetail`，`user-optional`）；`groupbuy.openGroups`（`public`）的 `leaderNickname`     | **PRODUCTION（设计如此）。** 拿到团链接的任何人（含未登录）能看到团员的 `userId`、昵称、头像。成人用品店里等于公开「谁买了什么」。另外 `wechat.sec-check.ts:35` 说昵称「不给其他顾客看」，并以此让昵称的内容安全 fail-open，这个前提不成立（见 B3）。                                                                                                                          | 是                                                                       | **已修**（L1 `c6c992a`，RISK-D-010，用户 2026-09-24 决定）：`groupbuy.groupDetail` / `withdraw` 的团员不再带 `userId`，改为会话算出的 `isMe`；团员昵称、`openGroups` 和海报的团长昵称一律打码为首字加一个 `*`（按字素，emoji 不拆；单字为 `*`；空为 null）。头像保留。api-compat 基线已按 `--unreleased` 重刷。                  |
| B1  | 中     | `apps/mini/src/session/renewing-transport.ts:34`、`apps/mini/src/session/session.ts:125`                                                                  | 401 续期用 `wx.login` 重新登录，登录到的是**持有本机 openid 的账号**，然后把失败的请求（读写都算）按新账号重放一次。账号 A 用密码登录（H6 之前不关联 openid），或本机 openid 已绑在账号 B 上：A 的会话过期后，A 正在提交的新增地址、申请发票、下单、加购会落到 B 的账号上，读到的也是 B 的数据。共用手机时是隐私问题。                                                         | 否（新客户端）                                                           | 只写出（`session/` 归 H6）。H6 让密码登录关联 openid 后常见情况消失，但「openid 已绑其他账号」的冲突情况仍在。建议：续期得到的账号与原会话不是同一个用户时不重放，回到未登录并提示重新登录。                                                                                                                                     |
| B2  | 中     | `packages/core/src/catalog/catalog.review.service.ts:359-361`（`skipped: null`）、`packages/core/src/wechat/wechat.sec-check.ts:180-192`、`:349`（61010） | 内容安全对「没有小程序 openid 的账号」直接跳过，跳过等于通过。任何人用 HTTP 客户端 `POST /api/v1/auth/sessions/sms`（不带 bindToken，新号即注册）或密码登录拿到会话，再发评价：`reviewRequiresAudit` 关闭时文字立即公开，图片永不检测（CONTENT-004 `skipped`）。有 openid 但两小时内没打开过小程序的账号，图片被 61010 标为 `skipped`，同样永不检测。                          | 否（master 没有内容安全，只有 `reviewRequiresAudit`）                    | **已修**（L1 `85f3e42`，CONTENT-006，用户 2026-09-24 决定）：内容安全开启且小程序已配置时，没有 mini openid 的账号发的评价进待审核（`sec_check_unchecked`）；评价图片检测以 `skipped` 结束（无 openid、61010、没有 https 地址）时，已发布的评价退回待审核（`sec_check_image_unchecked`）。已有原因（含管理员已通过）的评价不动。 |
| B3  | 低     | `packages/core/src/wechat/wechat.sec-check.ts:35-44`；`packages/core/src/user/user.service.ts:52-55`                                                      | 昵称在微信不可用时放行（fail-open），无 openid 的账号不检测。昵称实际会出现在拼团团页（P5），所以「不给其他顾客看」的前提不成立。                                                                                                                                                                                                                                              | 否                                                                       | **已处理**（随 P5）：昵称已打码，内容安全维持 fail-open（用户决定）；`wechat.sec-check.ts` 顶部「不给其他顾客看」的注释已改正（L1 `85f3e42`）。                                                                                                                                                                                  |
| B4  | 低     | `packages/core/src/wechat/wechat.config.ts:70`（默认 `plain`）、`packages/core/src/wechat/wechat.mini-push.ts:132-140`、`spendTriple`                     | 明文模式的签名只覆盖 `(token, timestamp, nonce)`，不覆盖 body；兼容模式下请求方可以不带 `Encrypt`，走同一条弱路径。防线是「签名三元组只能配一个 body」（Redis）和 5 分钟窗口。Redis 不可用时 `spendTriple` 放行：拿到一条带签名的推送 URL（边缘访问日志里有查询串）的人，5 分钟内可伪造 `trade_manage_order_settlement`，把对应订单标成已收货（`onSettlement` 信任推送内容）。 | 否（新接口）                                                             | **已修**（L1 `c99342a`，WXSHIP-008，用户 2026-09-24 决定）：明文 / 兼容模式下 Redis 不可用时推送回 503（不回 `success`，不入账），微信稍后重推；安全模式不变。仍建议运营选安全模式（HANDOFF §8）。                                                                                                                               |
| B5  | 低     | `packages/core/src/user/storefront-auth.service.ts:689`（`restorePending`）                                                                               | 手机号码或短信验证失败时把 bindToken 放回，并重新给满 10 分钟。一直失败就能让 bindToken 一直有效。单独无法利用（短信码有次数限制），但泄露的 bindToken 寿命不受限。                                                                                                                                                                                                            | 是（master 的 `oaPhoneLogin` 同样重设 TTL），本分支扩到 `miniPhoneLogin` | 只写出（登录状态机）。建议放回时保留原剩余 TTL（在 payload 里记过期时间）。                                                                                                                                                                                                                                                      |
| B6  | 低     | `packages/core/src/wechat/wechat.mini-code.service.ts:132`（`shareMiniCodeUrl`）                                                                          | `GET /api/v1/share/mini-codes?route=product&id=<任意>` 不检查商品、团、活动是否存在。每个账号每小时 30 个新码，码永久存储；用短信注册很多账号可消耗存储和 `getwxacodeunlimit` 配额。                                                                                                                                                                                           | 类似（master 的 `/api/v1/wechat/mini-qrcodes` 同一预算）                 | 只写出。建议铸码前确认对象存在且可见，或加一个全店每小时上限。                                                                                                                                                                                                                                                                   |
| B7  | 信息   | `packages/contracts/src/decor/decor.admin.contract.ts:314-318`                                                                                            | 只有 `decor:page:read` 的管理员也能签发预览令牌，把未发布草稿的链接交给外人（10 分钟，只读，单文档）。                                                                                                                                                                                                                                                                         | 否                                                                       | 可接受，记录在案。令牌本身：256 位随机、Redis 只存 SHA-256、TTL 10 分钟、绑定单个文档、不缓存（DECOR-012）。                                                                                                                                                                                                                     |
| B8  | 信息   | `coupon.claim`（`POST /api/v1/coupons/:id/claims`）                                                                                                       | 没有按请求的频率限制；上限来自每人限领和条件更新的库存。                                                                                                                                                                                                                                                                                                                       | 是                                                                       | 可接受。                                                                                                                                                                                                                                                                                                                         |

## 逐项检查结论（没有发现问题的也列出）

- **越权 / IDOR。** 发票抬头：每条查询和写入的 `WHERE` 都带 `userId`（`user.repo.ts` `liveTitleOf`），别人的 id 与不存在同样 404。
  `orders/:id/wechat-receipt`：`requireOwnOrder`。确认收货 `via: 'wechat-component'`：服务端自己调 `get_order` 核实，不信客户端。
  评价：资格由订单端口判定，「我的评价」按会话查。地址、领券：本分支没改服务。拼团 / 预售 `cardsFor`：只读，与列表同样的可见性。
- **后台路由权限。** 新增 16 个后台路由都声明了 `permission`（`defineRoute` 缺了会抛错），`handle()` 统一检查；`pnpm guards` permissions 通过。
- **装修预览令牌。** 见 B7，符合要求。
- **消息推送 webhook。** 签名在解析之前；Token 为空一律拒绝；body 64 KB 上限；5 分钟时效；三元组绑定 body；安全模式核对 appid；
  入账本按解密内容的 SHA-256 去重。未认证的调用者只能得到 403。明文 / 兼容模式的弱点见 B4。
- **结账 `kindMeta`。** 联合类型剥掉多余键；`kindSelections` 只取声明的键且 `kind` 最后写；`expectedPayableAmount` 只用于比较，价格全部由服务端算。
  预售已有测试（本任务补）：普通订单夹带 `{kind:'presale'}` 按原价、不占活动库存、不写预售行；真预售订单忽略多余键。
- **登录。** 静默登录和续期只认已知 openid；无效 code 按 IP 计失败次数（AUTH-006，IP 取边缘改写的 `X-Real-IP`）；bindToken 用
  `GETDEL`，一次性（B5 除外）；密码登录有窗口限次和验证码（master 已有）。日志：pino 按键名脱敏 `token`、`code`、`secret` 等，
  `handle()` 只记 pathname；小程序和 api-client 没有 `console.*`。`X-Client-Platform` / `X-Client-Version` 只用于会话标签、注册来源、
  订单平台统计和块的平台 / 版本可见性（「会员可见」看的是会话，不是请求头），不参与任何鉴权。
- **内容安全。** 策略表在 `wechat.sec-check.ts` 顶部和 C09，已写明：评价文字在微信失败时进待审核（fail-closed），昵称和发票抬头
  fail-open，图片事后检测。问题见 B2、B3。
- **富文本（DECOR-017）。** 白名单解析器，序列化时文本和属性都转义，保存、解析、客户端三次过滤。渲染器不用 `innerHTML`：小程序给
  `<rich-text>` 节点数组，H5 和后台画布用 React `createElement` 垫片并再次拒绝危险标签。改动的客户端代码里没有 `dangerouslySetInnerHTML`。
- **`LinkTarget`。** 契约只收 https 的 web-view 和格式正确的 AppID；客户端 `isWebviewAllowed` 只放 `mp.weixin.qq.com` 和配置的业务域名，
  `user@host`、端口等写法都被拒；web-view 页对 URL 参数再查一次（别的小程序带任意参数打开也一样）。登录页 `redirect` 是路由目录项，不是路径。
- **公共缓存层（DECOR-015）。** 公共层以匿名身份解析、按修订缓存；个人层只在有会话时计算、不缓存；响应只有 ETag，没有
  `Cache-Control: public`，边缘不缓存 API。
- **SSRF。** 本分支没有新增服务端 `fetch`；只有微信客户端和物流端口。
- **上传和生成的图片。** 用户上传按内容嗅探类型、拒绝 SVG、有大小上限和每小时预算（master 已有，有 int 测试）；头像（USER-019）和现在的
  评价图（CAT-018）必须是我们存的图；小程序码 scene 由路由目录编码，参数严格校验；海报在客户端绘制。
- **机密。** `/api/v1/app/config` 不含任何凭据；secrets 守卫通过（16 个机密字段对 461 个契约的响应）；示例和夹具都是假值；小程序
  `.env.*` 只有公开的 AppID，`mini` 守卫检查 32 位十六进制串。
- **频率限制。** 短信（按手机号、按 IP）、密码登录、小程序 code 失败、上传、小程序码都有；领券见 B8。

## Done

- 按 next-tasks.md 的清单审查完毕，结论见上。
- `50b2b08` test(order)：ORDER-009 预售半边：契约单测 2 条、`presale.checkout.int.test.ts` 3 条，`docs/invariants.md` 已引用。
- `f2913a6` fix(catalog)：评价图必须是我们存储里的图（CAT-018，新错误码 `CATALOG_REVIEW_IMAGE_NOT_ALLOWED`）；`catalog.int.test.ts`
  2 条；`wechat.sec-check.int.test.ts` 的图片用例改为先存附件；`docs/invariants.md` 新增 CAT-018。
- `6fe34aa` docs(storage)：`isStoredImageUrl` 的调用方注释。

## In progress

- 无。

## Pending

- 无（其余发现只写出，见上表）。

## 已运行的检查

- `pnpm --filter @shop/contracts typecheck`、`pnpm --filter @shop/core typecheck`：通过
- eslint（改动的 7 个文件）：通过
- `pnpm --filter @shop/contracts exec vitest run src/order/checkout-kind.test.ts src/contracts.test.ts`：19 + 15 通过
- `pnpm --filter @shop/api-client exec vitest run src/contract.test.ts src/types.test.ts`：255 通过
- `pnpm --filter @shop/contracts check:examples`：461 个路由通过
- `pnpm guards`：15 项，0 失败（invariants：282 条规则、848 处引用）
- `prettier --check`（改动的文件）：通过

## Tests for the orchestrator to run

改了或新写的 int 测试，本任务没有运行：

- `pnpm --filter @shop/core exec vitest run --project int src/catalog/catalog.int.test.ts`（CAT-018 两条，及整个 reviews 块）
- `pnpm --filter @shop/core exec vitest run --project int src/presale/presale.checkout.int.test.ts`（ORDER-009 三条）
- `pnpm --filter @shop/core exec vitest run --project int src/wechat/wechat.sec-check.int.test.ts`（图片用例现在先存附件）
- 可顺带跑 `e2e/storefront` 的 `specs-mini/reviews.spec.ts` 和旧版 `specs/ship-receive-review.spec.ts`：它们不传图，应不受影响。

## Page-form changes

- 无。评价页只在提交外部图片地址时多一个错误提示（正常上传不会出现）。

## Backend gaps / 交给其他任务

- **B1 → H6（`session/`）**：续期换了账号时不要重放请求。**已修**：B1-renew-account（AUTH-010）。
- **P4**：售后凭证图加 `isStoredImageUrl`。**已修**：L1-backend（REFUND-014）。

## Open questions（等用户决定）

1. **P1（线上 kindMeta）**：维持「不热修 master、随切换合入」。ICP 通过、外网提前开放时要重新提醒。
2. ~~**P5 / B3**~~：已定（HANDOFF §6.1）并由 L1-backend 落实：打码、去掉 `userId`，昵称内容安全维持 fail-open。
3. ~~**B2**~~：已定（§6.2）并由 L1-backend 落实（CONTENT-006）。
4. ~~**B4**~~：已定（§6.3）并由 L1-backend 落实（WXSHIP-008）。
