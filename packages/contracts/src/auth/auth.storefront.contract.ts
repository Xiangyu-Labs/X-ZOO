import { defineRoute } from '../_conventions/route';
import { userProfileExample } from '../user/schemas';
import {
  bindPhoneBody,
  changePasswordBody,
  logoutEverywhereResult,
  miniBindPhoneBody,
  miniLoginBody,
  miniPhoneLoginBody,
  oaAuthorizeUrlQuery,
  oaAuthorizeUrlResult,
  oaLoginBody,
  okResult,
  passwordLoginBody,
  registerBody,
  resetPasswordBody,
  sendSmsCodeBody,
  sendSmsCodeResult,
  smsLoginBody,
  smsLoginResult,
  storefrontSession,
  storefrontSessionExample,
  wechatBindPhoneBody,
  wechatLoginResult,
  wechatUserProfileExample,
} from './storefront-schemas';

/**
 * Storefront sign-in, `/api/v1/auth/**`.
 *
 * A session is a resource: you create one (with a password, an SMS code or a
 * WeChat identity), you delete the current one (退出登录), or you delete all of
 * them (退出所有设备). That is why there is no `POST /auth/logout` — the verb
 * was already in the method.
 *
 * Fifteen routes, one generation of auth. Nothing here returns a JWT, and
 * nothing accepts one.
 */

// ---------------------------------------------------------------------------
// verification codes
// ---------------------------------------------------------------------------

export const authSendSmsCode = defineRoute({
  id: 'auth.sendSmsCode',
  method: 'POST',
  path: '/api/v1/auth/sms-codes',
  auth: 'user-optional',
  summary: '发送短信验证码',
  tags: ['auth'],
  body: sendSmsCodeBody,
  response: sendSmsCodeResult,
  status: 202,
  errors: [
    'AUTH_SMS_TOO_FREQUENT',
    'AUTH_SMS_SEND_FAILED',
    'AUTH_CAPTCHA_REQUIRED',
    'AUTH_CAPTCHA_INVALID',
    'AUTH_PHONE_TAKEN',
    'AUTH_PHONE_ALREADY_BOUND',
  ],
  examples: [
    {
      name: 'login',
      body: { phone: '13800138000', scene: 'login' },
      response: { expiresInSec: 300, resendAfterSec: 60 },
    },
    {
      name: 'change-phone',
      body: { phone: '13900139000', scene: 'change-phone' },
      response: { expiresInSec: 300, resendAfterSec: 60 },
    },
  ],
});

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

/**
 * Password sign-in.
 *
 * With a `bindToken` (a parked `phone-required` WeChat sign-in) the password
 * also finishes that sign-in: once the password is right, the openid is linked
 * to the account, so the mini-program's next `wx.login` renewal signs in to it
 * silently (AUTH-009). The token is only read after the password check, so a
 * wrong password leaves it alone. It fails like the SMS path does:
 * `AUTH_WECHAT_BIND_EXPIRED` for a spent or expired token,
 * `AUTH_WECHAT_ALREADY_BOUND` when the openid, or this account's place on that
 * WeChat app, is already taken. Either way no session is issued, and the same
 * request without the token signs in without linking.
 */
export const authPasswordLogin = defineRoute({
  id: 'auth.passwordLogin',
  method: 'POST',
  path: '/api/v1/auth/sessions/password',
  auth: 'public',
  summary: '账号密码登录',
  tags: ['auth'],
  body: passwordLoginBody,
  response: storefrontSession,
  status: 201,
  errors: [
    'AUTH_INVALID_CREDENTIALS',
    'AUTH_ACCOUNT_DISABLED',
    'AUTH_TOO_MANY_ATTEMPTS',
    'AUTH_PASSWORD_NOT_SET',
    'AUTH_CAPTCHA_REQUIRED',
    'AUTH_CAPTCHA_INVALID',
    'AUTH_WECHAT_BIND_EXPIRED',
    'AUTH_WECHAT_ALREADY_BOUND',
  ],
  examples: [
    {
      name: 'ok',
      body: { account: '13800138000', password: 'xzoo123456' },
      response: storefrontSessionExample,
    },
    {
      name: 'links-mini-openid',
      body: {
        account: '13800138000',
        password: 'xzoo123456',
        bindToken: 'wxb_9d2b6e4a1c7f3085',
      },
      response: {
        ...storefrontSessionExample,
        user: { ...userProfileExample, boundWechat: ['mini'] },
      },
    },
  ],
});

export const authSmsLogin = defineRoute({
  id: 'auth.smsLogin',
  method: 'POST',
  path: '/api/v1/auth/sessions/sms',
  auth: 'public',
  summary: '短信验证码登录（未注册则自动注册）',
  tags: ['auth'],
  body: smsLoginBody,
  response: smsLoginResult,
  status: 201,
  errors: [
    'AUTH_SMS_CODE_INVALID',
    'AUTH_SMS_CODE_ATTEMPTS_EXCEEDED',
    'AUTH_ACCOUNT_DISABLED',
    'AUTH_TOO_MANY_ATTEMPTS',
  ],
  examples: [
    {
      name: 'existing-user',
      body: { phone: '13800138000', code: '123456' },
      response: { ...storefrontSessionExample, registered: false },
    },
    {
      name: 'new-user',
      body: { phone: '13700137000', code: '123456' },
      response: {
        ...storefrontSessionExample,
        registered: true,
        user: {
          ...userProfileExample,
          id: '1003',
          account: '13700137000',
          phone: '13700137000',
          nickname: '137****7000',
          avatarUrl: null,
          hasPassword: false,
          createdAt: '2026-09-22T10:00:00+08:00',
        },
      },
    },
  ],
});

/**
 * 小程序登录, and the mini-program's silent session renewal.
 *
 * A client holding no token, or one that just got a 401, calls `wx.login()` and
 * posts the code. A known openid comes back `signed-in` with `registered:
 * false` and a fresh token — no UI. `phone-required` only happens for an
 * openid the shop has never seen while 微信登录需绑定手机号 is on.
 * `docs/mini/auth.md` has the whole flow.
 *
 * `RATE_LIMITED`: one address sent too many codes WeChat refused (AUTH-006).
 * Valid codes never count.
 */
export const authMiniLogin = defineRoute({
  id: 'auth.miniLogin',
  method: 'POST',
  path: '/api/v1/auth/sessions/wechat-mini',
  auth: 'public',
  summary: '小程序登录',
  tags: ['auth'],
  body: miniLoginBody,
  response: wechatLoginResult,
  status: 201,
  errors: [
    'AUTH_WECHAT_NOT_CONFIGURED',
    'AUTH_WECHAT_CODE_INVALID',
    'AUTH_WECHAT_UNAVAILABLE',
    'AUTH_ACCOUNT_DISABLED',
    'USER_DISABLED',
    'RATE_LIMITED',
  ],
  examples: [
    {
      name: 'known-openid',
      body: { code: '081Kf2Ga1abcDE0xyz3Ga9KfXa1Kf2Gb' },
      response: {
        status: 'signed-in',
        session: { ...storefrontSessionExample, user: wechatUserProfileExample },
        registered: false,
        bindToken: null,
        bindTokenExpiresInSec: null,
      },
    },
    {
      name: 'needs-phone',
      body: { code: '081Kf2Ga1abcDE0xyz3Ga9KfXa1Kf2Gb' },
      response: {
        status: 'phone-required',
        session: null,
        registered: false,
        bindToken: 'wxb_4f1c8a2d7e6b5039',
        bindTokenExpiresInSec: 600,
      },
    },
  ],
});

/**
 * Finish a `phone-required` mini sign-in with `getPhoneNumber`'s code.
 *
 * When WeChat refuses the code the bind token survives (AUTH-007), so the
 * client can retry, or fall back to an SMS code on
 * `POST /auth/sessions/wechat-oa/phone` with the same token.
 */
export const authMiniPhoneLogin = defineRoute({
  id: 'auth.miniPhoneLogin',
  method: 'POST',
  path: '/api/v1/auth/sessions/wechat-mini/phone',
  auth: 'public',
  summary: '小程序手机号授权登录',
  tags: ['auth'],
  body: miniPhoneLoginBody,
  response: wechatLoginResult,
  status: 201,
  errors: [
    'AUTH_WECHAT_BIND_EXPIRED',
    'AUTH_WECHAT_CODE_INVALID',
    'AUTH_WECHAT_UNAVAILABLE',
    'AUTH_WECHAT_ALREADY_BOUND',
    'AUTH_ACCOUNT_DISABLED',
    'USER_DISABLED',
  ],
  examples: [
    {
      name: 'new-account',
      body: { bindToken: 'wxb_4f1c8a2d7e6b5039', phoneCode: 'e0c1f2d3a4b5968778695a4b3c2d1e0f' },
      response: {
        status: 'signed-in',
        session: { ...storefrontSessionExample, user: wechatUserProfileExample },
        registered: true,
        bindToken: null,
        bindTokenExpiresInSec: null,
      },
    },
  ],
});

/**
 * The OA OAuth redirect URL.
 *
 * Built server-side because the appid is not something the browser should be
 * asked to know, and because `redirectUrl` has to be checked against the
 * configured site host before it is handed to WeChat — an open redirect on the
 * authorisation endpoint hands the code to whoever asked for it.
 */
export const authOaAuthorizeUrl = defineRoute({
  id: 'auth.oaAuthorizeUrl',
  method: 'GET',
  path: '/api/v1/auth/wechat-oa/authorize-url',
  auth: 'public',
  summary: '获取公众号授权地址',
  tags: ['auth'],
  query: oaAuthorizeUrlQuery,
  response: oaAuthorizeUrlResult,
  errors: ['AUTH_WECHAT_NOT_CONFIGURED', 'AUTH_REDIRECT_NOT_ALLOWED'],
  examples: [
    {
      name: 'base',
      query: { redirectUrl: 'https://shop.example.com/pages/users/auth', scope: 'base' },
      response: {
        url: 'https://open.weixin.qq.com/connect/oauth2/authorize?appid=wx1234567890abcdef&redirect_uri=https%3A%2F%2Fshop.example.com%2Fapi%2Fv1%2Fauth%2Fwechat-oa%2Fcallback&response_type=code&scope=snsapi_base&state=9f1c8a2d#wechat_redirect',
        state: '9f1c8a2d',
      },
    },
  ],
});

export const authOaLogin = defineRoute({
  id: 'auth.oaLogin',
  method: 'POST',
  path: '/api/v1/auth/sessions/wechat-oa',
  auth: 'public',
  summary: '公众号授权登录',
  tags: ['auth'],
  body: oaLoginBody,
  response: wechatLoginResult,
  status: 201,
  errors: [
    'AUTH_WECHAT_NOT_CONFIGURED',
    'AUTH_WECHAT_CODE_INVALID',
    'AUTH_WECHAT_UNAVAILABLE',
    'AUTH_ACCOUNT_DISABLED',
  ],
  examples: [
    {
      name: 'known-openid',
      body: { code: '071Kf2Ga1abcDE0xyz3Ga9KfXa1Kf2Gc' },
      response: {
        status: 'signed-in',
        session: {
          ...storefrontSessionExample,
          user: { ...wechatUserProfileExample, registerSource: 'wechat_oa', boundWechat: ['oa'] },
        },
        registered: false,
        bindToken: null,
        bindTokenExpiresInSec: null,
      },
    },
    {
      name: 'needs-phone',
      body: { code: '071Kf2Ga1abcDE0xyz3Ga9KfXa1Kf2Gc' },
      response: {
        status: 'phone-required',
        session: null,
        registered: false,
        bindToken: 'wxb_7a3e9c1b2d4f6058',
        bindTokenExpiresInSec: 600,
      },
    },
  ],
});

/**
 * Finish an OA sign-in: the OA has no `getPhoneNumber`, so it is an SMS code.
 *
 * Despite the path, it finishes **any** parked WeChat sign-in, the
 * mini-program's included: a shopper who declines 微信手机号快捷登录 in the
 * mini-program posts the same `bindToken` here with an SMS code, and the mini
 * openid is linked (AUTH-007). That is the mini-program's SMS alternative
 * (`docs/mini/auth.md`), so the platform stays unchecked on purpose. A plain
 * `POST /auth/sessions/sms` also signs the shopper in but leaves the openid
 * unlinked, so the next launch asks for a phone number again.
 *
 * The code must be minted with **`scene: 'login'`**, not `bind-phone`. The
 * caller has no session yet — that is the whole point of the route — and
 * `bind-phone` is the signed-in "add a number to the account I am already
 * using" scene, which `POST /auth/sms-codes` refuses to issue anonymously. The
 * privilege is identical either way: holding a code sent to the number is what
 * `auth.smsLogin` already accepts as proof of ownership.
 */
export const authOaPhoneLogin = defineRoute({
  id: 'auth.oaPhoneLogin',
  method: 'POST',
  path: '/api/v1/auth/sessions/wechat-oa/phone',
  auth: 'public',
  summary: '公众号绑定手机号并登录',
  tags: ['auth'],
  body: wechatBindPhoneBody,
  response: wechatLoginResult,
  status: 201,
  errors: [
    'AUTH_WECHAT_BIND_EXPIRED',
    'AUTH_WECHAT_ALREADY_BOUND',
    'AUTH_SMS_CODE_INVALID',
    'AUTH_SMS_CODE_ATTEMPTS_EXCEEDED',
    'AUTH_ACCOUNT_DISABLED',
  ],
  examples: [
    {
      name: 'links-existing-account',
      body: { bindToken: 'wxb_7a3e9c1b2d4f6058', phone: '13800138000', code: '123456' },
      response: {
        status: 'signed-in',
        session: {
          ...storefrontSessionExample,
          user: { ...userProfileExample, boundWechat: ['oa'] },
        },
        registered: false,
        bindToken: null,
        bindTokenExpiresInSec: null,
      },
    },
  ],
});

export const authLogout = defineRoute({
  id: 'auth.logout',
  method: 'DELETE',
  path: '/api/v1/auth/sessions/current',
  auth: 'user',
  summary: '退出登录',
  tags: ['auth'],
  response: okResult,
  examples: [{ name: 'ok', response: { ok: true } }],
});

/**
 * 退出所有设备.
 *
 * Revokes every live session of the account including the caller's own, which
 * is what somebody who has just realised their phone was stolen wants.
 */
export const authLogoutEverywhere = defineRoute({
  id: 'auth.logoutEverywhere',
  method: 'DELETE',
  path: '/api/v1/auth/sessions',
  auth: 'user',
  summary: '退出全部设备',
  tags: ['auth'],
  response: logoutEverywhereResult,
  examples: [{ name: 'ok', response: { revoked: 3 } }],
});

// ---------------------------------------------------------------------------
// registration and passwords
// ---------------------------------------------------------------------------

export const authRegister = defineRoute({
  id: 'auth.register',
  method: 'POST',
  path: '/api/v1/auth/registrations',
  auth: 'public',
  summary: '手机号注册',
  tags: ['auth'],
  body: registerBody,
  response: storefrontSession,
  status: 201,
  errors: [
    'AUTH_SMS_CODE_INVALID',
    'AUTH_SMS_CODE_ATTEMPTS_EXCEEDED',
    'AUTH_PHONE_TAKEN',
    'AUTH_TOO_MANY_ATTEMPTS',
  ],
  examples: [
    {
      name: 'ok',
      body: {
        phone: '13700137000',
        code: '123456',
        password: 'xzoo123456',
        nickname: '新用户',
      },
      response: {
        ...storefrontSessionExample,
        user: {
          ...userProfileExample,
          id: '1003',
          account: '13700137000',
          phone: '13700137000',
          nickname: '新用户',
          avatarUrl: null,
          createdAt: '2026-09-22T10:00:00+08:00',
        },
      },
    },
  ],
});

export const authResetPassword = defineRoute({
  id: 'auth.resetPassword',
  method: 'POST',
  path: '/api/v1/auth/password-resets',
  auth: 'public',
  summary: '短信验证码重置密码',
  tags: ['auth'],
  body: resetPasswordBody,
  response: okResult,
  errors: [
    'AUTH_SMS_CODE_INVALID',
    'AUTH_SMS_CODE_ATTEMPTS_EXCEEDED',
    'AUTH_INVALID_CREDENTIALS',
    'AUTH_ACCOUNT_DISABLED',
  ],
  examples: [
    {
      name: 'ok',
      body: { phone: '13800138000', code: '123456', password: 'xzoo654321' },
      response: { ok: true },
    },
  ],
});

export const authChangePassword = defineRoute({
  id: 'auth.changePassword',
  method: 'PUT',
  path: '/api/v1/auth/password',
  auth: 'user',
  summary: '修改密码',
  tags: ['auth'],
  body: changePasswordBody,
  response: okResult,
  errors: [
    'AUTH_OLD_PASSWORD_INVALID',
    'AUTH_PASSWORD_UNCHANGED',
    'AUTH_SMS_CODE_INVALID',
    'AUTH_SMS_CODE_ATTEMPTS_EXCEEDED',
    'AUTH_PHONE_NOT_BOUND',
  ],
  examples: [
    {
      name: 'with-old-password',
      body: { oldPassword: 'xzoo123456', password: 'xzoo654321' },
      response: { ok: true },
    },
    {
      name: 'with-sms-code',
      body: { code: '123456', password: 'xzoo654321' },
      response: { ok: true },
    },
  ],
});

// ---------------------------------------------------------------------------
// phone binding
// ---------------------------------------------------------------------------

export const authBindPhone = defineRoute({
  id: 'auth.bindPhone',
  method: 'POST',
  path: '/api/v1/auth/phone',
  auth: 'user',
  summary: '绑定手机号',
  tags: ['auth'],
  body: bindPhoneBody,
  response: okResult,
  errors: [
    'AUTH_SMS_CODE_INVALID',
    'AUTH_SMS_CODE_ATTEMPTS_EXCEEDED',
    'AUTH_PHONE_TAKEN',
    'AUTH_PHONE_ALREADY_BOUND',
  ],
  examples: [
    { name: 'ok', body: { phone: '13700137000', code: '123456' }, response: { ok: true } },
  ],
});

/**
 * 微信授权手机号, for an account that is already signed in.
 *
 * Separate from `POST /api/v1/auth/phone` rather than an optional field on it:
 * that route proves the number with an SMS code this shop paid to send, this
 * one takes WeChat's word for it, and the two refuse for entirely different
 * reasons. There is no `PUT` sibling — replacing a number the customer already
 * has is 更换手机号, and that flow keeps its SMS code.
 */
export const authBindPhoneWechatMini = defineRoute({
  id: 'auth.bindPhoneWechatMini',
  method: 'POST',
  path: '/api/v1/auth/phone/wechat-mini',
  auth: 'user',
  summary: '小程序一键绑定手机号',
  tags: ['auth'],
  body: miniBindPhoneBody,
  response: okResult,
  errors: [
    'AUTH_WECHAT_NOT_CONFIGURED',
    'AUTH_WECHAT_CODE_INVALID',
    'AUTH_PHONE_TAKEN',
    'AUTH_PHONE_ALREADY_BOUND',
  ],
  examples: [{ name: 'ok', body: { phoneCode: 'mp-phone-code-abc' }, response: { ok: true } }],
});

export const authChangePhone = defineRoute({
  id: 'auth.changePhone',
  method: 'PUT',
  path: '/api/v1/auth/phone',
  auth: 'user',
  summary: '更换手机号',
  tags: ['auth'],
  body: bindPhoneBody,
  response: okResult,
  errors: [
    'AUTH_SMS_CODE_INVALID',
    'AUTH_SMS_CODE_ATTEMPTS_EXCEEDED',
    'AUTH_PHONE_TAKEN',
    'AUTH_PHONE_NOT_BOUND',
  ],
  examples: [
    { name: 'ok', body: { phone: '13900139000', code: '123456' }, response: { ok: true } },
  ],
});
