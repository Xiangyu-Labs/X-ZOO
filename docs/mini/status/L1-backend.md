# L1-backend 状态

分支 `storefront/mini-L1-backend`（自 `storefront/mini` @ c3afbac0a）。落实 HANDOFF §6 第 1–3 条用户决定，以及 K1 的 P4。
对应 K1 行：P4、P5、B2、B3、B4（`docs/mini/status/K1-security.md` 已标为已修）。

## Done

- `c6c992a` fix(groupbuy)：**P5 / B3，RISK-D-010。** `groupbuy.groupDetail`（及 `withdraw`，同一个视图）的团员去掉 `userId`，新增会话算出的
  `isMe`；团员昵称、`groupbuy.openGroups` 和 `groupbuy.poster` 的团长昵称一律打码：首个字素加一个 `*`（「小明明」→「小*」；单字名为 `*`；
  空白为 null；emoji 和 ZWJ 组合不拆，用 `Intl.Segmenter`）。头像保留。纯函数 `maskNickname`（`groupbuy.rules.ts`）有单测。
  海报对团长本人也打码：海报本来就是拿去转发的，而且任何登录顾客都能取任何团的海报数据。小程序本来就不显示团员昵称和 id，
  只改了 3 个测试夹具；旧 uni-app 的映射改为用 `pinkT.isMine` 决定是否显示「取消开团」（原来比较 uid），夹具和映射测试同步。
  api-compat 基线已按 `cutover.md` §5 用 `--unreleased` 重刷，「原谅」了两条：`members[].userId` 在 `GET /groupbuy/groups/{id}` 和
  `POST …/withdrawal` 的响应里被删除。
- `f115494` fix(refund)：**P4，REFUND-014。** `refund.apply` 在锁订单之前检查每张凭证图都是 `isStoredImageUrl`，否则新错误码
  `REFUND_IMAGE_NOT_ALLOWED`（422，「请上传凭证图片后再提交」）。只加校验，退款流程没动。小程序申请售后页用 `ImageUploader`
  （`purpose="refund"`），提交的就是上传接口返回的 URL，不受影响。
- `85f3e42` fix(wechat)：**B2，CONTENT-006（新规则）。** 内容安全开启且小程序已配置时：
  - `checkText` 对没有 mini openid 的账号返回新结论 `unchecked`（开关关闭或小程序未配置仍是 `skipped`）；评价按 `unavailable` 处理进待审核，
    原因 `sec_check_unchecked`。昵称和发票抬头只在 `risky` 时拒绝，不受影响。
  - 评价图片检测以 `skipped` 结束（无 openid、61010、「对外地址」不是 https）时，在标记 `skipped` 的同一事务里调用新的
    `registerMediaUncheckedHandler('review_image', holdUncheckedReview)`，把已发布的评价退回待审核，原因 `sec_check_image_unchecked`，
    检测行 `action = 'review_held'`。已有原因的评价（文字被扣下，或被扣下后管理员已通过）不动；重复投递不重复处理。
  - 评价管理的原因标签新增「非小程序账号，未经内容安全检测」「图片未经内容安全检测」。
  - `wechat.sec-check.ts` 顶部说昵称「不给其他顾客看」的注释改正（**B3**）：昵称会打码出现在拼团上，内容安全维持 fail-open（用户决定）。
  - `docs/invariants.md` 的 CONTENT-001、CONTENT-004 文字更新，新增 CONTENT-006；`docs/mini/wechat-compliance.md` C09 同步
    （策略段、代码段、验证段，以及昵称说明和售后凭证行）。
- `c99342a` fix(wechat)：**B4，WXSHIP-008（新规则）。** `wechat.mini-push.ts`：明文 / 兼容模式下 Redis 不可用时，推送回 `503 try again later`，
  不入账，微信稍后重推；安全模式不变（签名覆盖密文）。`wechat.mini-push.test.ts` 4 条单测，用假 ctx，不需要数据库。
- K1 状态表 P4、P5、B2、B3、B4 标为已修，未决问题 2–4 划掉。

## In progress

- 无。

## Pending

- 无。

## 已运行的检查

- `pnpm --filter @shop/contracts typecheck`、`@shop/core`、`@shop/mini`、`@shop/web`：通过
- `pnpm --filter @shop/contracts lint`、`@shop/core lint`、`@shop/mini lint`：通过；web 改动的 1 个文件 eslint 通过
- `pnpm --filter @shop/core exec vitest run src/groupbuy/groupbuy.rules.test.ts src/wechat/wechat.mini-push.test.ts --maxWorkers=2`：29 通过
- `pnpm --filter @shop/mini exec vitest run src/features/groupbuy/team.test.ts src/packages/promo/groupbuy-team/index.test.tsx src/packages/promo/groupbuy-detail/index.test.tsx --maxWorkers=2`：43 通过
- `apps/uni-app`：`vitest run tests/mappers.activity.test.mjs`：24 通过
- `pnpm guards`：16 项，0 失败（重刷基线前 api-compat 报告上面两条破坏，只报告）
- `prettier --check`（改动的文件）：通过

## Tests for the orchestrator to run

本任务改了或新写、**没有运行**的 int 测试：

```sh
pnpm --filter @shop/core exec vitest run --project int src/groupbuy/groupbuy.int.test.ts        # RISK-D-010 新 1 条；「shows paid, unrefunded members only」和海报 SHARE-002 改为「小*」
pnpm --filter @shop/core exec vitest run --project int src/groupbuy/groupbuy.smoke.int.test.ts  # SMOKE-009 海报昵称改为「小*」
pnpm --filter @shop/core exec vitest run --project int src/wechat/wechat.sec-check.int.test.ts  # CONTENT-001 1 条改写，CONTENT-004 1 条加断言，CONTENT-006 新 4 条
pnpm --filter @shop/core exec vitest run --project int src/refund/refund.int.test.ts            # REFUND-014 新 2 条
```

没有改 e2e。建议顺带跑（行为可能受影响，但都应通过）：

- `e2e/storefront/specs-mini/reviews.spec.ts`、`orders.spec.ts`、`account.spec.ts`（评价；用户都是小程序登录、有 openid，不传图）
- `e2e/storefront/specs-mini/aftersale.spec.ts`（申请售后；不传凭证图）
- `e2e/storefront/specs-mini/promo.spec.ts`、`share.spec.ts`（拼团页和海报）
- 旧版 `e2e/storefront/specs/groupbuy.spec.ts`（uni-app 拼团状态页，「取消开团」改为看 `pinkT.isMine`）

## Page-form changes（旧 → 新，需要告诉用户）

- 拼团：接口里团员昵称「小明」→「小*」，团员不再带账号 id。小程序页面本来就不显示团员昵称，**顾客看到的没有变化**；旧 H5 拼团状态页的团员名变成打码形式。
- 评价（内容安全开启且小程序已配置时）：
  - 非小程序账号（H5、用 HTTP 客户端短信 / 密码登录）发评价：旧「立即公开」（评价需审核关闭时）→ 新「待审核」，顾客看到「评价已提交，审核后展示」。
  - 评价的图片微信检测不了（顾客两小时内没打开过小程序、站点对外地址不是 https）：旧「一直公开、从不检测」→ 新「已发布的评价退回待审核」，
    我的评价里状态变成「审核后展示」，商品页暂时看不到，等后台通过。
  - 后台评价管理：待审核原因新增两种文字。**运营要留意待审核会变多**（尤其对外地址不是 https 时，每条带图评价都会进待审核）。
- 申请售后：凭证图是外部链接时，旧「照收」→ 新报错「请上传凭证图片后再提交」。正常在小程序里上传不会出现。
- 消息推送（明文 / 兼容模式）：Redis 故障期间，旧「照收」→ 新「回 503，微信重推」。安全模式无变化。

## Backend gaps / 交给其他任务

- 公众号回调 `wechat-oa.webhook.service.ts` 的 `spendTriple` 也是 Redis 不可用时放行。没有公众号（HANDOFF §6），本任务没改。
- 旧 uni-app 的 H5 拼团分享链接原来带团长 uid 作 `spid`，现在是 0；uni-app 切换时删除，不处理。

## Open questions

1. 海报数据对团长本人也打码（「小*」）。小程序海报本来不画昵称，所以无影响；如果以后海报要画「XX 邀请你拼团」，要不要对团长本人显示全名？
2. CONTENT-006 对「对外地址不是 https」也把评价退回待审核（检测不了就不算通过）。如果生产的对外地址确实是 https，这条不会触发；否则每条带图评价都要人工审核。
