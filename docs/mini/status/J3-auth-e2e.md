# J3-auth-e2e 状态

分支 `storefront/mini-J3-auth-e2e`（自 `storefront/mini` @ 2d7936c9f）。

## Done

- **密码登录**：登录页「其他方式 · 密码登录」（`features/auth/password-login.tsx`、`pages/login`），`session.ts` 新增
  `signInWithPassword`（`auth.passwordLogin`，不改状态机的其他分支）。忘记密码 → 找回密码。单元测试
  `pages/login/index.test.tsx`、`session/session.test.ts`；e2e `specs-mini/login.spec.ts::SMOKE-004: …`，`docs/invariants.md`
  SMOKE-004 已引用。openid **不关联**（见 Backend gaps）。
- **`ui/Button` 在 H5 有 `role="button"`**：`H5_BUTTON_ROLE` 只在 `TARO_ENV === 'h5'` 时展开，weapp 输出不变。平台里的原生按钮
  （手机号、头像、隐私同意、客服）同样处理。`account.spec.ts` 去掉 `[aria-label=…]` 绕行，改用 `getByRole('button')`。
- **隐私弹窗 e2e**：`platform/privacy.ts` 抽出 `needPrivacyAuthorization`（weapp 仍由 `Taro.onNeedPrivacyAuthorization` 调它）；
  `h5-mp-emulation.tsx` 在手机号、头像、选地址、选图、发票抬头之前按微信的方式调它（emulation 数据 `privacy: 'undecided'`，默认
  `'agreed'`）。e2e：同意 → 继续登录；拒绝 → 只失败这一次，再点再弹。登录页把隐私拒绝提示为中文。
- **我的 页 e2e**：`specs-mini/user-center.spec.ts` 三条（内置个人中心、已登录的头部 / 订单入口 / 我的服务、访客的 登录 / 注册）。
- **文档**：`docs/mini/e2e-coverage.md`（密码登录、我的、账户页、隐私弹窗、SMOKE-004、缺口表）、`docs/mini/auth.md`（密码登录、
  隐私保护指引）、`docs/mini/pages.md`（登录页落地调整）、`e2e/storefront/README.md`（`privacy` emulation 数据）。

## In progress

- 无。

## Pending

- 无。

## 合并检查清单（2026-09-24）

- `pnpm exec prettier --check .`：通过
- `pnpm exec turbo run typecheck lint build`：35/35 通过
- `pnpm exec turbo run test:unit --concurrency=2`：16/16 通过
- `pnpm guards`：通过
- `pnpm --filter ./e2e/storefront test:mini`：全量 43 条，42 passed（含 `coupons.spec.ts` 预售那条预期失败 `test.fail`，J1 在修），1 failed：SMOKE-004 的「登录」按钮定位器同时匹配到「使用微信登录」；加 `exact` 后单跑 `login.spec.ts` 7/7 通过
- 没有改 core 包，不需要 int 测试

## Page-form changes

- 登录：旧 = 计划写「『其他方式』里放密码登录」，页面上没有 → 新 = 微信方式下方一条带细线的小标题「其他方式」，下面文字按钮
  「密码登录」，任何状态都显示；点开在同一页换成密码表单（账号 / 密码、登录，文字按钮「使用微信登录」「忘记密码」）。原因：计划要求，
  同页切换不多开一个页面。
- 登录：旧 = 手机号按钮因隐私被拒时 toast 微信的英文 `errMsg` → 新 = 「未同意隐私保护指引，可改用短信验证码登录」。原因：全中文文案。

## Backend gaps

- `auth.passwordLogin` 没有 `bindToken`（pages.md 第 5 节「`auth.smsLogin`、`auth.passwordLogin` 改契约」，H1，未做），也没有
  已登录关联小程序 openid 的接口。后果：密码登录的会话到期后，续期走 `wx.login`，回到 手机号快速登录（或登录到这个 openid 已绑定的
  另一个账号）。选项：a) `passwordLoginBody` 加可选 `bindToken`，core 校验密码后关联身份；b) 新增已登录的「关联小程序 openid」接口
  （body `{ code }`）。两者都要动 core auth，不在本流范围。

## Open questions

- `session/login-card.tsx`（A）和 `packages/account/phone`（E）的手机号按钮在隐私被拒时仍 toast 微信的英文 `errMsg`；可改用
  `isPrivacyRefusal` 统一成中文，本流未动（不是本流的文件）。
- 密码登录是否应在 `phone-required` 之外也显示（现在任何状态都显示）；按计划如此处理。
- emulation 字段用 `privacy: 'agreed' | 'undecided'`，不是简报建议的 `'agree' | 'reject'`：测试点的是真正弹窗里的 同意 / 拒绝 按钮，
  所以数据只需说明「是否已同意过」。
