import { defineErrors } from '../_conventions/errors';

export const authErrors = defineErrors({
  AUTH_INVALID_CREDENTIALS: { status: 401, message: '账号或密码不正确' },
  AUTH_ACCOUNT_DISABLED: { status: 403, message: '账号已被禁用，请联系管理员' },
  /** Per-account throttle. Everything sits behind one shared proxy, so per-IP would be useless. */
  AUTH_TOO_MANY_ATTEMPTS: { status: 429, message: '登录尝试过于频繁，请稍后再试' },
  AUTH_CAPTCHA_REQUIRED: { status: 400, message: '请先完成滑块验证' },
  AUTH_CAPTCHA_INVALID: { status: 400, message: '滑块验证未通过，请重试' },
  AUTH_SESSION_EXPIRED: { status: 401, message: '登录已过期，请重新登录' },
  /** The cookie-auth CSRF guard (Origin / Sec-Fetch-Site) rejected the request. */
  AUTH_CROSS_SITE_BLOCKED: { status: 403, message: '请求来源不可信' },
  /** A `Bearer shp_…` API token that is unknown, revoked, expired, or whose admin was disabled or changed password. */
  AUTH_TOKEN_INVALID: { status: 401, message: 'API 令牌无效、已过期或已吊销' },
  /** Minting or revoking tokens from a token: an agent must not be able to give itself a second life. */
  AUTH_TOKEN_CONSOLE_ONLY: { status: 403, message: 'API 令牌只能在后台登录后管理' },
});

export type AuthErrorCode = keyof typeof authErrors;

/**
 * Storefront sign-in. A second registry in the same file because `pnpm gen`
 * aggregates one `errors.ts` per domain and flattens every export in it — so
 * both surfaces stay legible without inventing a second domain folder.
 *
 * Nothing here distinguishes "no such account" from "wrong password", and
 * nothing here reveals whether a phone number is registered. Both would be free
 * account enumeration against a shop whose login name *is* a phone number.
 */
export const storefrontAuthErrors = defineErrors({
  /** No SMS provider configured, or the provider refused the send. */
  AUTH_SMS_SEND_FAILED: { status: 502, message: '验证码发送失败，请稍后再试' },
  /** Per-phone or per-IP budget. Distinct from `RATE_LIMITED` so the client can say why. */
  AUTH_SMS_TOO_FREQUENT: { status: 429, message: '验证码发送过于频繁，请稍后再试' },
  /**
   * Wrong code, expired code, already-spent code, or a code minted for another
   * scene. One code for all four: the atomic `GETDEL` that consumes it cannot
   * tell them apart, and guessing afterwards would be a fact-shaped lie.
   */
  AUTH_SMS_CODE_INVALID: { status: 400, message: '验证码不正确或已过期' },
  /** Too many wrong guesses against one minted code; it has been destroyed. */
  AUTH_SMS_CODE_ATTEMPTS_EXCEEDED: { status: 429, message: '验证码错误次数过多，请重新获取' },

  /** Registration hit `users_phone_lower_uq`, or a rebind targeted a taken number. */
  AUTH_PHONE_TAKEN: { status: 409, message: '该手机号已被使用' },
  /** The account exists but has no password: it was created by SMS code or by WeChat. */
  AUTH_PASSWORD_NOT_SET: { status: 409, message: '该账号未设置密码，请使用验证码登录' },
  AUTH_OLD_PASSWORD_INVALID: { status: 400, message: '原密码不正确' },
  /** A password change must actually change it, or every session is revoked for nothing. */
  AUTH_PASSWORD_UNCHANGED: { status: 400, message: '新密码不能与原密码相同' },
  /** Binding a phone to an account that already has one, without going through 换绑. */
  AUTH_PHONE_ALREADY_BOUND: { status: 409, message: '该账号已绑定手机号' },
  /** A flow that needs a bound number (change-phone, SMS-proof password change) without one. */
  AUTH_PHONE_NOT_BOUND: { status: 409, message: '该账号尚未绑定手机号' },

  /** The `wechat-mini` / `wechat-oa` config group is empty or disabled. */
  AUTH_WECHAT_NOT_CONFIGURED: { status: 503, message: '微信登录暂未开放' },
  /** WeChat refused `code2session` / `oauth2/access_token`: expired, reused, or wrong app. */
  AUTH_WECHAT_CODE_INVALID: { status: 400, message: '微信授权已失效，请重新授权' },
  /** WeChat answered with an error we cannot act on, or did not answer at all. */
  AUTH_WECHAT_UNAVAILABLE: { status: 502, message: '微信服务暂时不可用，请稍后再试' },
  /** The short-lived token from a `phone-required` response expired or was already spent. */
  AUTH_WECHAT_BIND_EXPIRED: { status: 400, message: '授权已过期，请重新登录' },
  /** That openid already belongs to another account. */
  AUTH_WECHAT_ALREADY_BOUND: { status: 409, message: '该微信已绑定其他账号' },
  /** `redirectUrl` pointed outside the configured site host. */
  AUTH_REDIRECT_NOT_ALLOWED: { status: 400, message: '回调地址不在允许范围内' },
});

export type StorefrontAuthErrorCode = keyof typeof storefrontAuthErrors;
