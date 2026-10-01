# B1-renew-account 状态

分支 `storefront/mini-B1-renew-account`（自 `storefront/mini` @ 30f6e878a）。来源：K1 安全审查 B1（中），
`docs/mini/status/K1-security.md`。

## Done

- **客户端**（f4916e80f）：401 续期只以发出请求的那个账号重放（新规则 AUTH-010）。
  - `session/session.ts`：登录成功时把账号 id 和 token 一起存（新存储键 `shop.session.user`，`USER_KEY`），内存里另记本次启动
    每个 token 属于哪个账号。续期（`renew`，多个请求共用一次）拿到 `signed-in` 后比较账号：同一账号照旧保存、重放；
    **不是同一账号**，或原会话账号未知时，不保存新会话、用新 token 调 `auth.logout` 吊销（尽力而为）、状态设为 `signed-out`，
    返回 `null`。
  - 新增 `renewFor(sent)`，作为 transport 的续期钩子：`sent` 是当前 token（或正在续期）就续期并共用结果；会话已被别的请求续期
    换掉时，只有当前 token 属于同一账号才用它重放；未登录时直接不重放，不再发第二次 `wx.login`。续期换了账号时打开登录页
    一次（`navigate({ route: 'login' })`，不 await）。~~到达后 toast~~ → 见下「修复：提示改为登录页上的一行字」。
  - `renewSession()`（修改密码页在用）保留，同样的账号比较，但不打开登录页（修改密码页自己 toast 并返回）。
  - `session/renewing-transport.ts`：钩子改为 `renew(sent)`，不再自己判断「token 已过期换新」，交给会话判断。
  - 会话目录外的改动（仅适配签名）：`data/api.ts` 的 `AuthHooks.renew` 改为 `(sent) => …`；`data/upload.ts` 传入发出的 token。
  - 测试夹具：`test/account-fixture.ts` 的 `signIn()` 同时存账号 id `'7'`；`packages/account/password/index.test.tsx` 的续期返回
    带 `user.id: '7'`（原来是 `{}`，否则会被判为另一账号）。
  - 单元测试 `session/session.test.ts` 新增 `describe('AUTH-010 — …')` 6 条：同账号重放写请求且不开登录页；换账号：写只发一次、
    `signed-out`、本地 token 和账号 id 清掉、新会话被吊销（`DELETE …/sessions/current` 带新 token）、401 抛出、登录页一次 + 提示；
    三个请求同时 401：一次 `wx.login`、都不重放、登录页一次；无账号 id 的旧 token：不重放、登出；过期 token 遇到别的账号的当前
    会话：不重放、不续期；`renewSession()` 换账号：登出、不开登录页。原有 4 条续期测试补存账号 id `'7'`。
    `data/upload.test.ts` 断言 `renew` 收到发出的 token。
- **E2E + 规则**（881bec843）：`specs-mini/login.spec.ts` 新增 `AUTH-010: a write that meets an ended password session is not
replayed as the account this phone's WeChat belongs to, and the shopper is back at the login page`（放在 SMOKE-004 之后）：
  登录页 `phone-required` → 把本机 openid 绑给账号 B → 密码登录账号 A（关联被拒 409，客户端去掉 `bindToken` 重登）→ 商品页
  选好规格 → 吊销 A 的会话 → 点 加入购物车 → 断言：一次 `wx.login`、`POST /cart/items` 只有一次且为 401、A 和 B 的购物车都没有行、
  B 没有未吊销的会话、本地 token 清空、回到登录页并显示「登录已过期，请重新登录」。
  `docs/invariants.md` 新增 AUTH-010（引用 6 条单元测试 + 这条 e2e）；`docs/mini/auth.md`「401：续期」「密码登录」「不变量」、
  `docs/mini/e2e-coverage.md` 续期行已更新。

- **修复：提示改为登录页上的一行字**（orchestrator 跑 e2e 时 AUTH-010 失败：toast 没出现）。trace 显示登录页打开时屏幕上的 toast
  是加购失败自己的「请先登录」（商品页 `onError: toast.text(error.message)`），它在我们的 toast 之后弹出并把它替换掉（一次只有
  一个 toast；H5 上 `hideLoading` 也会隐藏它）。真机同样会被顶掉。改为：
  - `session.ts` 新增 `useSessionNotice`（zustand，`notice: string | null`）和 `clearSessionNotice()`；`sendToLogin` 在打开登录页
    **之前**设置 `notice = SESSION_ENDED`，不再 toast。任何登录成功（`signedIn`）和 `logout` 清掉它。
  - `pages/login/index.tsx`：有 `notice` 时在店名下方用它替换「登录后可以下单、查看订单和领取优惠券」（`login__hint--notice`，
    次要文字色）；页面卸载时 `clearSessionNotice`。
  - 单元测试：`session.test.ts` 改为断言 `notice`（换账号、并发都设置一次；同账号和 `renewSession()` 不设置），新增「重新登录后
    notice 清掉」；`pages/login/index.test.tsx` 新增 2 条（有 notice 时替换提示、卸载后清掉；没有时显示原提示）。
  - e2e 断言不用改（`getByText` 同样找到页面上的文字），只改了注释。invariants AUTH-010 文字与引用、auth.md 同步。

## In progress

- 无。

## Pending

- 无（e2e 由 orchestrator 跑，见下）。`K1-security.md` 的 B1 行不是本流的文件，没有改；合并后可标记已修复。

## 本流跑过的检查

- `pnpm --filter @shop/mini exec vitest run src/session src/data/upload.test.ts src/packages/account/password src/pages/login --maxWorkers=2`：
  5 文件 34 条通过；修复后同一命令 5 文件 37 条通过
- typecheck：`@shop/mini`、`@shop/e2e-storefront` 通过
- eslint：mini 改动文件、`e2e/storefront/specs-mini/login.spec.ts` 通过
- `pnpm guards`：16 项 0 失败（invariants 287 条规则、873 处引用全部解析）；改动文件 `prettier --check` 通过

## Tests for the orchestrator to run

- e2e（新增 1 条，修复后请重跑；同文件的 SMOKE-004 与两条续期测试走的是同账号路径，行为应不变，建议整文件跑一次）：
  `pnpm --filter @shop/e2e-storefront test:mini -- specs-mini/login.spec.ts`
- 可选（`account-fixture.signIn()` 多存了一个键，19 个页面测试文件在用，按理不受影响）：
  `pnpm --filter @shop/mini exec vitest run src/packages/account --maxWorkers=2`

## Page-form changes

- 会话过期后续期登录到了**另一个账号**时（例：共用手机，账号 A 密码登录，本机微信已绑账号 B）：
  旧 = 静默变成账号 B，A 正在提交的地址 / 发票 / 下单 / 加购落到 B 名下，页面显示 B 的数据；
  新 = 不重放，回到未登录，打开登录页，店名下方原来的「登录后可以下单、查看订单和领取优惠券」换成「登录已过期，请重新登录」（登录或离开后恢复），提交的操作报错（页面照常显示该请求的错误提示）。
  原因：隐私和数据归属（K1 B1）。
- 升级后第一次续期：本地 token 是本版本之前存的（没有账号 id）时，会话到期不再静默续期，而是同上回到登录页一次；之后照常静默续期。
  小程序尚未正式营业（生产未交易），影响的用户极少。
- 同一账号续期（绝大多数情况）：不变，静默续期并重放。

## Backend gaps

- 无。没有改后端认证状态机。吊销另一账号的新会话用现有的 `DELETE /api/v1/auth/sessions/current`。

## Open questions

- **原账号未知时的取舍**：保守处理（不重放、登出、去登录页），代价是升级后第一次续期多一次登录页。也可以改为「续期成功但不重放，
  保留新会话」，但那样可能静默登录到另一个账号，所以没有这样做。
- **登录页没有 `redirect`**：会话层不知道当前页面，登录后回首页。如果希望回到原页面，需要 `@/platform` 提供当前路由，或登录页接受
  提示参数；这超出了本任务范围（只改 `session/`）。
- ~~提示文案可能被页面的错误 toast 顶掉~~：确实会（e2e 证实），已改为登录页上的一行字。页面自己的错误 toast（如「请先登录」）
  仍会在商品页短暂出现，这是页面原有行为，没有改。
- **过期 token 碰到别的账号的当前会话**（在途请求期间用户退出并登录了别的账号，极少见）：现在不重放，但客户端的
  `onUnauthorized` 仍会把当前会话置为 `idle`（这是原有行为，客户端的 `onUnauthorized` 不知道是哪个 token 的 401）。
  以前这种情况会以新账号重放。
- 登录页打开后，用户点「微信一键登录」仍会登录到本机 openid 绑定的账号 B——这是用户主动选择，符合预期；「密码登录」回到 A。
