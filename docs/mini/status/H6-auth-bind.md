# H6-auth-bind 状态

分支 `storefront/mini-H6-auth-bind`（自 `storefront/mini` @ f0a0b50）。

## Done

- **后端**（779d84b）：`passwordLoginBody` 加可选 `bindToken`（与 `miniPhoneLoginBody` / `wechatBindPhoneBody` 同样的
  `z.string().min(1).max(256)`）。`passwordLogin` 在节流、验证码、密码校验、`assertUsable`、md5 升级、清零失败计数之后，
  `takePending` 取出挂起的身份，用现有的 `linkIdentity` 关联到这个账号，再签发会话（`linkPendingToAccount`）。密码错误不读
  `bindToken`；过期 / 用过是 `AUTH_WECHAT_BIND_EXPIRED`；openid 已属于别人、或账号已绑过另一个同平台 openid 是
  `AUTH_WECHAT_ALREADY_BOUND`（与短信方式 `completeWithPhone` 相同，token 不放回），都不签发会话。契约加这两个错误码和示例
  `links-mini-openid`。int 测试 `storefront-auth.int.test.ts::password login that finishes a parked mini sign-in`（5 条，AUTH-009），
  `docs/invariants.md` 新增 AUTH-009。
- **客户端**（8482dd8）：`session.ts` `signInWithPassword` 在 `phone-required` 时带上 `bindToken`；关联被拒（`BIND_EXPIRED` /
  `ALREADY_BOUND`，密码其实是对的）时去掉 `bindToken` 再提交一次，照常登录不关联。单元测试 `session/session.test.ts`（带 token、
  无挂起不带、两种拒绝各重试一次、错密码不重试且保持 `phone-required`）；`pages/login/index.test.tsx` 一处断言改为带 `bindToken`。
- **隐私拒绝文案**（ef2aa51）：`session/login-card.tsx` 用 `isPrivacyRefusal` 提示「未同意隐私保护指引，可改用短信验证码登录」；
  `packages/account/phone` 提示「未同意隐私保护指引，可改用其他手机号绑定」。单元测试 `session/login-card.test.tsx`（新）、
  `packages/account/phone/index.test.tsx`。
- **E2E**（557fd6a）：`specs-mini/login.spec.ts::SMOKE-004`（标题不变）：先等 `phone-required`（手机号快速登录 按钮出现），错密码后
  正确密码登录，断言 openid 关联到密码账号；然后 `DELETE /api/v1/auth/sessions` 吊销，进 购物车，401 续期只一次 `wx.login`，回到同一
  账号（新 token 的 `/api/v1/profile` 手机号相同），购物车行重放后可见。AUTH-009 引用了这条。
- **文档**：`docs/mini/auth.md`「密码登录」「隐私保护指引」「不变量」；`docs/mini/e2e-coverage.md` §1 密码登录行、§4 缺口删除。

## In progress

- 无。

## Pending

- 无（int / e2e 由 orchestrator 跑，见下）。

## 本流跑过的检查

- `pnpm --filter @shop/mini exec vitest run src/session src/packages/account/phone src/pages/login --maxWorkers=2`：4 文件 25 条通过
- `pnpm --filter @shop/contracts exec vitest run src/contracts.test.ts`：15 通过；`check:examples`：461 路由通过
- typecheck：`@shop/contracts`、`@shop/core`、`@shop/mini`、`@shop/e2e-storefront` 通过
- lint：`@shop/contracts`；core、mini、e2e 改动文件的 eslint 通过
- `pnpm guards`：15 项 0 失败（invariants 282 条规则、847 处引用全部解析）；改动文件 `prettier --check` 通过

## Tests for the orchestrator to run

- int：`pnpm --filter @shop/core exec vitest run --project int src/user/storefront-auth.int.test.ts`（新增 AUTH-009 五条，其余不应变化）
- e2e：`pnpm --filter @shop/e2e-storefront test:mini -- specs-mini/login.spec.ts`（SMOKE-004 扩展；同文件其余 6 条不应变化）

## Page-form changes

- 登录卡片（`LoginCard`）：旧 = 隐私被拒时 toast 微信英文 `errMsg` → 新 =「未同意隐私保护指引，可改用短信验证码登录」。原因：全中文文案，
  与登录页一致。
- 手机号（个人中心）：旧 = 同上英文 `errMsg` → 新 =「未同意隐私保护指引，可改用其他手机号绑定」（页上的替代入口是「使用其他手机号」）。
- 登录页密码登录：界面不变；从 `phone-required` 登录后 openid 被关联，会话到期后静默续期回到同一账号（原来回到登录页）。

## Backend gaps

- `auth.smsLogin` 仍不接受 `bindToken`（pages.md 第 5 节那一行只完成了 `passwordLogin`）。小程序的短信方式走
  `auth.oaPhoneLogin`，已经关联 openid，所以对小程序没有缺口。
- 没有「已登录后关联小程序 openid」的接口：不在 `phone-required` 时（如退出后）的密码登录不关联。

## Open questions

- 关联被拒时客户端自动去掉 `bindToken` 重试一次（不关联地登录），而不是报错。理由：密码是对的，报错会让「其他方式」这个出口也走不通
  （例如账号已绑定另一个微信号）。如希望提示用户，可在第二次成功后加一条 toast。
- AUTH-009 是新编号；如果并行的 K1 也新增了 AUTH-009，合并时需要改号。
- `docs/mini/pages.md` 第 425 行（计划表「`auth.smsLogin`、`auth.passwordLogin` 改契约」）不是本流的文件，没有改；passwordLogin 那一半
  已完成。
