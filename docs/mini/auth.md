# 小程序登录与会话

微信小程序客户端怎样登录、续期、处理 401、绑定手机号、退出。接口的权威定义在
`packages/contracts/src/auth/auth.storefront.contract.ts`，本文只讲顺序和取舍。

## 约定

- 每个请求都带 `X-Client-Platform: wechat-mini`。服务端把它记到会话上（`user_sessions.platform`），新账号的
  `register_source` 也由它决定。
- 登录成功后拿到的 `session.token` 放在 `Authorization: Bearer <token>` 里，服务端只认这一个头。
- token 只存本地（`wx.setStorageSync`），不要打印到日志，不要拼进 URL。
- 出错时响应体是 `{ code, message, details? }`。按 `code` 分支，`message` 可以直接给用户看。
- 开关先看 `GET /api/v1/app/config`：`auth.wechatMini` 为 `false` 时小程序登录没开，只能走短信登录。
  `auth.wechatRequiresPhone` 为 `true` 时，新用户第一次微信登录会得到 `phone-required`，可以提前把绑定手机号的界面准备好；
  但仍以登录接口的实际返回为准。

## 启动：静默登录

小程序每次冷启动，或者本地没有 token 时：

1. `wx.login()` 拿 `code`（一次性，约 5 分钟有效）。
2. `POST /api/v1/auth/sessions/wechat-mini`，body `{ code }`。
3. 看响应的 `status`：
   - `signed-in`：保存 `session.token`、`session.expiresAt` 和 `session.user`，结束。用户什么也看不到。
     `registered: true` 只在这次调用新建了账号时出现（只有关闭「微信登录需绑定手机号」时才会这样），可以用来弹一次
     新人引导；老用户永远是 `false`。
   - `phone-required`：这个 openid 从没见过，而店铺要求先绑手机号。保存 `bindToken`，它在
     `bindTokenExpiresInSec`（600 秒）内有效，进入下面的「绑定手机号」。

已知的 openid 不需要手机号，也不需要任何弹窗，直接 `signed-in`。同一个人在公众号用过（`unionid` 相同）也算已知，会登录到同一个账号。

有了本地 token 的热启动不需要重新登录，直接用。

## 401：续期

token 默认 30 天有效（后台「登录保持天数」`sessionTtlDays`）。过期、被后台禁用、改了密码、在别处点了「退出所有设备」，接口都会返回
401 `UNAUTHENTICATED`，原因不区分。

客户端的处理只有一种：

1. 丢掉本地 token。
2. 重新 `wx.login()`，调 `POST /api/v1/auth/sessions/wechat-mini`（就是「启动」那一步）。
3. 拿到 `signed-in`，并且是**原来那个账号**，就把原请求重放**一次**；拿到 `phone-required` 就去绑定手机号页面。
4. 续期本身失败（再次 401 或其他错误）不要循环重试，停在登录页。
5. 续期登录到的是**另一个账号**（AUTH-010）：不重放。`wx.login` 登录的是持有本机 openid 的账号，它可能不是会话过期的那个
   （例如密码登录时关联被拒，openid 属于别人）。这时新会话立即吊销（`DELETE /api/v1/auth/sessions/current`，带新 token）、
   不保存，回到未登录（`signed-out`），原请求的 401 照常抛给调用方，然后打开登录页，登录页在店名下方显示「登录已过期，请重新登录」（一行文字，不是 toast：失败请求的调用方同时会弹自己的错误 toast，会把它顶掉），登录或离开登录页后消失。
   原会话属于哪个账号不知道时（本地只有 token、没有账号 id，即 AUTH-010 之前存下的 token）同样处理。

要点：

- 同一时刻多个请求一起 401 时，只发一次续期，其他请求等它的结果：同一个账号都重放，换了账号都不重放，登录页只打开一次。
- 登录成功时把账号 id 和 token 一起存下（`shop.session.user`），续期后据此比较。一个请求带的 token 已被别的请求续期换掉时，
  只在当前 token 属于同一账号时用它重放。
- 续期只签发新 token，不会让这个用户在其他设备上的会话失效。
- 被禁用的账号续期会得到 403 `USER_DISABLED`，这时提示联系客服，不要再试。
- 同一个 IP 在 10 分钟内连续提交 20 个被微信判为无效的 `code` 后，这个接口会返回 429 `RATE_LIMITED`（`details.retryAfterMs`
  是需要等待的毫秒数）。正常启动的有效 `code` 不计数，所以正常用户不会碰到；碰到了就按 `retryAfterMs` 等待，不要立刻重试。

## 绑定手机号（`phone-required` 之后）

拿到 `bindToken` 后给用户两个选择。

### 方式一：微信手机号快捷登录

1. 用 `<button open-type="getPhoneNumber" @getphonenumber="...">` 让用户授权，回调里拿 `e.detail.code`。不要用
   `encryptedData`/`iv`，服务端不支持在客户端解密。
2. `POST /api/v1/auth/sessions/wechat-mini/phone`，body `{ bindToken, phoneCode: e.detail.code }`。
3. 成功返回 `signed-in`。这个手机号已有账号时会绑定到原账号（`registered: false`），否则新建账号（`registered: true`）。

用户拒绝授权时回调里没有 `code`，直接改走方式二，`bindToken` 还能用。

微信拒绝了 `phoneCode`（过期、已用过，400 `AUTH_WECHAT_CODE_INVALID`；或微信暂时不可用，502 `AUTH_WECHAT_UNAVAILABLE`）时，`bindToken`
**仍然有效**：可以让用户再点一次授权，也可以改走方式二，都不需要重新 `wx.login()`。

### 方式二：短信验证码

1. `POST /api/v1/auth/sms-codes`，body `{ phone, scene: 'login' }`。必须是 `login` 场景，`bind-phone` 场景要求已登录，这里还没有会话。
2. `POST /api/v1/auth/sessions/wechat-oa/phone`，body `{ bindToken, phone, code }`。

路径里虽然写着 `wechat-oa`，但它可以完成**任何**挂起的微信登录，包括小程序的，并且会把小程序 openid 绑定到这个账号上，所以下次启动就是静默登录。验证码输错时（`AUTH_SMS_CODE_INVALID`）`bindToken`
不会作废，用户改正后重新提交即可；错太多次（`AUTH_SMS_CODE_ATTEMPTS_EXCEEDED`）需要重新获取验证码。

不要改用 `POST /api/v1/auth/sessions/sms`：它也能登录，但不会绑定 openid，下次启动还会要求绑定手机号。

### 其他错误

- 400 `AUTH_WECHAT_BIND_EXPIRED`：`bindToken` 过期或已用过。回到「启动」重新 `wx.login()`。
- 409 `AUTH_WECHAT_ALREADY_BOUND`：这个手机号的账号已经绑定了另一个小程序 openid。提示用户，不要自动重试。
- 403 `USER_DISABLED`：账号已被禁用。

## 密码登录（登录页「其他方式」）

登录页在微信方式下方有「其他方式 · 密码登录」，任何状态都显示（包括 `phone-required`）。表单是「账号」（手机号或账号）和「密码」，
协议仍须先勾选；「忘记密码」进找回密码页，「使用微信登录」回到微信方式。

1. `POST /api/v1/auth/sessions/password`，body `{ account, password }`（账号去掉首尾空格）。当前是 `phone-required` 时，
   body 里再带上挂起的 `bindToken`：`{ account, password, bindToken }`。
2. 成功直接得到 `session`，保存 token，状态变为 `signed-in`。带了 `bindToken` 时，服务端在密码校验通过**之后**把这个小程序
   openid 关联到该账号（和短信、手机号快速登录用的是同一个关联），`bindToken` 就此用掉。
3. 401 `AUTH_INVALID_CREDENTIALS`（「账号或密码不正确」，账号不存在也是这句）显示在密码框下；这个 401 请求没带 token，不触发续期。
   密码错误时服务端不读 `bindToken`，它仍然有效，改对密码再提交即可。
   `AUTH_CAPTCHA_REQUIRED` / `AUTH_CAPTCHA_INVALID`：小程序没有滑块，提示「尝试次数较多，请稍后再试或使用短信验证码登录」。
   其他错误（429、403 `USER_DISABLED`）直接提示 `message`。

**关联 openid（AUTH-009）。** 密码登录时关联了 openid，会话到期（或被「退出所有设备」吊销）后的 401 续期走 `wx.login`，
静默回到**同一个**账号，和其他登录方式一样。关联被拒、openid 属于别的账号时，续期不会换成那个账号继续操作：
不重放、回到登录页（AUTH-010，见「401：续期」）。

只有关联本身被拒时，密码登录才会因 `bindToken` 失败，这时不签发会话：

- 400 `AUTH_WECHAT_BIND_EXPIRED`：`bindToken` 过期（10 分钟）或已用过；
- 409 `AUTH_WECHAT_ALREADY_BOUND`：这个 openid 已属于别的账号，或这个账号已经绑定了另一个小程序 openid（和短信方式的冲突相同）。

这两种情况密码本身是对的，客户端（`signInWithPassword`）去掉 `bindToken` 再提交一次，照常登录但不关联 openid：token 在
`sessionTtlDays` 内照常使用，到期后的续期回到 `phone-required`（登录页）；续期碰到这个 openid 已绑定的另一个账号时，
不登录到那个账号，回到登录页（AUTH-010）。
`AUTH_WECHAT_ALREADY_BOUND` 这样重登成功后，登录页离开、到了要去的页面之后，toast（3 秒）「此微信已关联其他账号，本账号需用密码登录」
（`takeSignInHint`，只提示一次）：下次打开小程序会静默登录到那个账号，要用本账号得退出后再用密码登录。`AUTH_WECHAT_BIND_EXPIRED`
不提示（什么都没绑，下次打开还会问手机号）。提示放在跳转之后：放在登录页上会随登录页一起消失，跳转途中弹出微信可能不显示。
不在 `phone-required` 时（例如退出后）没有 `bindToken`，同样不关联。

## 隐私保护指引

`installPrivacyHandler` 注册 `wx.onNeedPrivacyAuthorization`：第一次调用隐私接口（手机号、头像、选地址、选图、发票抬头）前，
微信回调它，页面上的 `<PrivacySheet>` 弹出；「同意」放行这次调用，「拒绝」让这次调用失败（`errMsg` 含
`privacy permission is not authorized`）。客户端用 `isPrivacyRefusal` 识别它，不显示微信的英文 `errMsg`：登录页和登录卡片
（`LoginCard`）提示「未同意隐私保护指引，可改用短信验证码登录」，`bindToken` 不受影响；个人中心的「手机号」页提示
「未同意隐私保护指引，可改用其他手机号绑定」。再点一次会再弹。

H5「模拟小程序」模拟同一个流程：emulation 数据 `privacy: 'undecided'` 时，这几个接口先调同一个处理函数
（`needPrivacyAuthorization`），同意后记在 `localStorage` 里；默认 `'agreed'`，不弹。真机上的行为不变。

## 已登录后再绑定手机号

通过其他方式登录、还没有手机号的用户，在个人中心点「微信授权手机号」：`POST /api/v1/auth/phone/wechat-mini`，body
`{ phoneCode }`，需要登录。也可以用短信：先 `POST /api/v1/auth/sms-codes`（`scene: 'bind-phone'`，需要登录），再
`POST /api/v1/auth/phone`。

## 退出

- 退出当前设备：`DELETE /api/v1/auth/sessions/current`（带 Bearer）。服务端吊销这个 token，客户端清掉本地 token 和用户信息。
- 退出所有设备：`DELETE /api/v1/auth/sessions`。包括当前设备。
- 退出后回到首页即可。下次需要登录时走「启动」流程，已知 openid 会直接静默登录，这是预期行为。

## 不变量

- AUTH-006：只有被微信拒绝的 `code` 计入每个 IP 的失败额度，有效 `code` 永远不计数。
- AUTH-007：`getPhoneNumber` 的 code 被微信拒绝时 `bindToken` 保留；同一个 `bindToken` 可以改用短信完成，并绑定小程序 openid。
- AUTH-008：已知 openid 静默续期：同一账号、`registered: false`、有效期为 `sessionTtlDays` 的新 token，不创建任何行，不影响其他会话；被禁用的账号不续期。
- AUTH-009：密码登录带 `bindToken` 时，密码正确才关联 openid，之后的 `wx.login` 续期回到同一账号；密码错误不关联也不用掉 `bindToken`；
  冲突与短信方式相同（`AUTH_WECHAT_ALREADY_BOUND`），不签发会话；不带 `bindToken` 不关联任何东西。
- AUTH-010：401 续期只以发出请求的那个账号重放；续期登录到另一个账号（或原账号未知）时吊销新会话、回到未登录、不重放，
  登录页只打开一次并在页面上显示「登录已过期，请重新登录」。

对应的测试在 `packages/core/src/user/storefront-auth.int.test.ts` 的 `mini-program session renewal`（AUTH-006～008）和
`password login that finishes a parked mini sign-in`（AUTH-009）中；AUTH-010 是客户端规则，测试在
`apps/mini/src/session/session.test.ts` 和 `e2e/storefront/specs-mini/login.spec.ts`。
