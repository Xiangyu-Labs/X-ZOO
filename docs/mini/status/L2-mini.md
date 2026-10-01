# L2-mini 状态

分支 `storefront/mini-L2-mini`（自 `storefront/mini` @ c3afbac0a）。来源：HANDOFF §4 第 4、6 条和 §6 用户决定第 4、5 条
（H6 提示、K3 防连点和两处重复代码、K2 删除 NutUI、分包预算 1 MB）。

## Done

- **H6 提示**（ce8433820、70820cbe6）：`session.ts` `signInWithPassword` 带 `bindToken` 被 `AUTH_WECHAT_ALREADY_BOUND` 拒绝、
  去掉 `bindToken` 重登成功后，留下一条一次性提示 `LINK_REFUSED_HINT`「此微信已关联其他账号，本账号需用密码登录」
  （`takeSignInHint()` 取一次即清；任何登录、退出都会清掉）。登录页在 `returnFromLogin` 完成、到了要去的页面**之后**
  `toast.long`（3 秒）显示它。e2e：`specs-mini/login.spec.ts` AUTH-010 那条加了一句断言（未跑）。为什么不放登录页上：登录成功后登录页马上离开，B1 那种页内提示看不到；跳转途中弹 toast 微信可能丢掉。
  `AUTH_WECHAT_BIND_EXPIRED` 不提示（什么都没绑，下次打开还会问手机号）。
  - 文案没用「密码或短信」：openid 属于别的账号时，下次打开会静默登录到那个账号，登录页只剩「密码登录」，短信方式只在
    `phone-required` 时出现。
  - `platform/feedback.ts` `showToast(title, durationMs = 1500)`；`ui/feedback.ts` 新增 `toast.long`（3 秒，两行的句子）。
  - 单元测试：`session/session.test.ts`（两种拒绝码：ALREADY_BOUND 有提示、BIND_EXPIRED 没有，只取一次；关联成功没有提示、
    未取的提示被下次登录清掉），`pages/login/index.test.tsx`（提示在 `switchTab` 之后、3000 ms）。`docs/mini/auth.md`「密码登录」。
- **K3 防连点**（4a4d7f6a0）：`platform/nav.ts` `navigate` 的 `navigateTo` / `redirectTo` 经过 `openOnce`：
  - 同一方法、同一 URL（含参数）的第二次调用，在第一次进行中时共用它的结果（不再调微信）；
  - 第一次落地后 500 ms 内、且页面栈深度没变（还停在打开的那页）时丢弃；返回过（栈变了）或超过 500 ms 照常打开；
  - 打开失败立即忘掉，重试能打开；不同页面、`replace` 与 push 互不影响；`switchTab` 不拦（重复切 tab 无害）。
  - `src/test/setup.ts` 每个测试后 `resetOpenGuard()`（假 Taro 的栈深度不随 `navigateTo` 变，否则下一个测试打开同一页会被当成连点）。
  - 单元测试 `platform/nav.test.ts` 新增 4 条（进行中共用、落地后同栈丢弃 / 返回后和 500 ms 后放行、其他页面和 tab 放行、失败后重试）。
- **K3 重复代码**（589177f1a）：`features/cart/cart-view.ts` 的 `centsOf` / `moneyFromCents` 删掉，改用 `lib/money.ts` 的
  `toCents` / `fromCents`（金额测试挪到新文件 `lib/money.test.ts`）。区别：畸形字符串旧的算 0、现在是 `NaN`；用在「再买 ¥x 可用」
  提示里，两者都不出提示（`NaN > 0` 为假），接口金额本来也不会畸形。`aftersale/apply` 删掉自己的 `REFUND_READS`，用
  `shared/actions.ts` 的（多一个 `refund.myDetail`，新申请无害）。
- **K2 删除 NutUI**（b39245e8f）：
  - `apps/mini/package.json` 删 `@nutui/nutui-react-taro`；`pnpm-lock.yaml` 随 `pnpm install` 更新（-20 个包）；
    `pnpm-workspace.yaml` 删 NutUI 的 `packageExtensions` 和两条 `overrides`。
  - 删 `src/ui/tokens/nutui-bridge.scss` 和 `app.scss` 里的 `@use`；`config/index.ts` 的 `designWidth` 从「`@nutui` 文件 375，其余 750」
    改为 `750`；`eslint.config.mjs` 删两条 NutUI 规则；`size-report.mjs` 删「NutUI 整包入口」检查（依赖已不在，进不了构建）。
  - `mini` 守卫 `[nutui]` 改为「任何地方（包括 `src/ui/`）都不许引用 `@nutui/*`」，防止再引入；变异 `nutui-in-stylesheet` 改为
    `nutui-in-kit`（`src/ui/mutant.scss`），`guards/README.md` 同步。
  - 当前文档：`docs/mini/README.md`、`design.md`（§1.2、主题一节删 NutUI 桥接、组件规则、守卫表）、`wechat-compliance.md` C13
    「依赖」、`docs/conventions.md`、`docs/architecture.md`、`lib/defined.ts` 注释。`spikes/S1-taro.md`、`plan.md`、`next-tasks.md`、
    其他 status 文档是历史记录，没改。
- **K2 分包预算 1 MB**（b39245e8f）：`size-report.mjs` 默认 `--subpackage-kb` 2048 → **1024**。C13、`pages.md` §1、
  `app.config.ts` 注释原本就写 1 MB；`README.md` 从 2 MB 改为 1 MB，`pages.md` §1、C13、`app.config.ts` 注释补一句「构建门禁卡住」。
- **`pages.md` 第 425 行**：`auth.passwordLogin` 标为已完成（H6，AUTH-009）；`auth.smsLogin` 不需要（小程序短信方式走 `auth.oaPhoneLogin`）。

## In progress

- 无。

## Pending

- 无（e2e 由 orchestrator 跑，见下）。

## 本流跑过的检查

- `pnpm --filter @shop/mini exec vitest run --maxWorkers=2`（全部小程序单测，一次）：120 文件 606 条通过
- 开发中的定向单测：session / login / feedback 35 条；nav 22 条；cart / money / aftersale / 购物车页 32 条，均通过
- `pnpm --filter @shop/mini typecheck`、`lint`：通过；`@shop/guards` `typecheck`、`lint`：通过
- `guards` 的 `src/checks/mini.mutations.test.ts`、`src/lib/mini.test.ts`：43 条通过；`pnpm guards`：16 项 0 失败
- 改动文件 `prettier --write`/检查
- `pnpm --filter @shop/mini build:weapp`（一次，含门禁，预算 主包 1536 / 分包 1024 / 总计 8192 KB）：`size-report: ok`
  - main 686.3 KB、goods 22.4、order 99.8、aftersale 50.5、promo 69.8、account 120.4、content 14.9、page 3.7，总计 1067.8 KB
  - （K2 基线 main 682.0 / 总计 1064.7 KB，之后 H6、B1、K1、K3 等合并加了几 KB；本流删掉的配色桥接约 2 KB）
  - 构建输出里的 mini-css-extract-plugin「Conflicting order」是已有的警告，不影响结果

## Tests for the orchestrator to run

- **`pnpm --filter @shop/e2e-storefront test:mini`（整套一次）**：`navigate` 的防连点影响所有 push / replace 跳转（K3 要求改后跑全套）。
  特别看：
  - `specs-mini/login.spec.ts`（**改了**）：AUTH-010 那条的密码登录正是「关联被拒 409 → 去掉 `bindToken` 重登」，登录回到首页后
    新增一句断言：看得到 toast「此微信已关联其他账号，本账号需用密码登录」（H6）。toast 不带遮罩，不挡后面的点击。SMOKE-004
    （关联成功）不应出现这句；
  - 连续两次打开同一页面的用例（如果有在 500 ms 内、同一栈深度下重复打开同一 URL 的，会被当成连点）。
- `pnpm --filter @shop/mini build`（含 H5）：本流只构建了 weapp。`designWidth` 改成常数、删掉配色桥接也影响 H5 和模拟构建。
- 真机（device-check）：D12 体积；连点「结算」「立即购买」只开一页；H6 提示在真机上能看到（从 `phone-required` 用已绑别的微信的
  账号密码登录）。

## Page-form changes（旧 → 新）

- 登录页密码登录，本机微信已关联别的账号（或本账号已关联别的微信）时：旧 = 静默登录，没有任何说明；新 = 登录后到了要去的页面，
  toast 3 秒「此微信已关联其他账号，本账号需用密码登录」。原因：用户决定（HANDOFF §6 第 4 条），让顾客知道下次打开会是另一个账号。
- 连点「结算」「立即购买」或任何卡片、链接：旧 = 可能叠两层同一页面（两个确认订单）；新 = 只打开一次。正常点击没有变化；
  打开后 0.5 秒内停在新页面时，同一个跳转再来一次会被忽略。
- 购物车「再买 ¥x 可用」、售后申请提交后的刷新：没有可见变化（代码合并）。
- 删除 NutUI、分包预算：没有可见变化。

## Backend gaps

- 无。

## Open questions

- 提示文案用了「本账号需用密码登录」，没有写「或短信」：openid 属于别人时，下次打开会静默登录到那个账号，登录页只提供密码登录。
  如果希望保留用户原话「密码或短信登录」，改 `LINK_REFUSED_HINT` 一处即可。
- 提示时长 3 秒（设计规范 toast 是 1.5 秒，这句两行读不完），新增了 `toast.long`。
- 防连点窗口 500 ms（K3 建议 ~800 ms）。落地后还要求栈深度没变，所以返回后立刻再点同一张卡片不受影响；如需更长可改 `REPEAT_MS`。
- `goBack`（`navigateBack`）没有加防连点：连点「返回」可能退两页。本任务没要求，未改。
- `BIND_EXPIRED` 时仍然不提示也不重新关联（可以改成先 `wx.login` 拿新的 `bindToken` 再关联，但那是登录状态机的改动）。
