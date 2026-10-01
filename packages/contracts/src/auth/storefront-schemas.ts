import { z } from 'zod';
import { instant, newPassword } from '../_conventions/common';
import { userProfile, userProfileExample, type UserProfile } from '../user/schemas';

/**
 * Storefront sign-in.
 *
 * One generation of auth: one token format and one notion of "bound", for the
 * mini-program, the OA and H5 alike. There is no compatibility surface.
 *
 * The session is an **opaque bearer token**, not a JWT. It is hashed into
 * `user_sessions` (`UserSessionService`), carries the `password_version` it was
 * minted with, and dies the instant that version moves — which is what makes
 * "改密码 = 所有设备下线" true rather than aspirational.
 */

// ---------------------------------------------------------------------------
// SMS codes
// ---------------------------------------------------------------------------

/**
 * Why a code is being asked for.
 *
 * The scene is part of the Redis key, so a code minted for 注销 cannot be
 * replayed against 登录. With one key per phone number for every purpose, a
 * code sent to confirm a phone change would also log you in.
 */
export const smsScene = z.enum([
  'login',
  'register',
  'reset-password',
  'bind-phone',
  'change-phone',
]);
export type SmsScene = z.infer<typeof smsScene>;

export const phoneNumber = z.string().regex(/^1[3-9]\d{9}$/, '手机号格式不正确');

/** Six digits. Kept as a string so a leading zero survives the wire. */
export const smsCode = z.string().regex(/^\d{6}$/, '验证码为 6 位数字');

export const sendSmsCodeBody = z.object({
  phone: phoneNumber,
  scene: smsScene,
  /** Present once the slider captcha is switched on; ignored while it is off. */
  captchaToken: z.string().max(4096).optional(),
});
export type SendSmsCodeBody = z.infer<typeof sendSmsCodeBody>;

/**
 * Deliberately says nothing about whether the number is registered.
 *
 * `POST /auth/sms-codes` with `scene=login` answers identically for a known and
 * an unknown number, because the alternative is a free "is this person a
 * customer of yours" lookup for anybody with a phone book.
 */
export const sendSmsCodeResult = z.object({
  /** How long the code stays valid. */
  expiresInSec: z.number().int().min(1),
  /** How long before this phone may ask again. */
  resendAfterSec: z.number().int().min(0),
});
export type SendSmsCodeResult = z.infer<typeof sendSmsCodeResult>;

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

/**
 * What a successful sign-in hands back.
 *
 * The profile travels with the token for the same reason the admin login
 * carries `adminProfile`: the first screen after login needs it, and a second
 * round trip on a phone on 4G is a visible stall.
 */
export const storefrontSession = z.object({
  /** `Authorization: Bearer <token>`. Shown once; only its sha256 is stored. */
  token: z.string(),
  expiresAt: instant,
  user: userProfile,
});
export type StorefrontSession = z.infer<typeof storefrontSession>;

export const passwordLoginBody = z.object({
  /** Account name or phone number; matched case-insensitively. */
  account: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
  captchaToken: z.string().max(4096).optional(),
  /**
   * A parked WeChat sign-in (`phone-required`) to finish with this password:
   * once the password is right, its openid is linked to the account, exactly
   * as `auth.miniPhoneLogin` and `auth.oaPhoneLogin` link theirs, so the next
   * `wx.login` renewal signs in to this account. Single-use. Omit it and
   * nothing is linked.
   */
  bindToken: z.string().min(1).max(256).optional(),
});
export type PasswordLoginBody = z.infer<typeof passwordLoginBody>;

/**
 * Code login, which also registers.
 *
 * A phone that has no account gets one, because the alternative — a 404 that
 * tells the shopper to go and register with the same phone and the same code —
 * is where a sign-up funnel loses people. `registered` in the response says
 * which happened, so the client can show 欢迎加入 once.
 */
export const smsLoginBody = z.object({
  phone: phoneNumber,
  code: smsCode,
});
export type SmsLoginBody = z.infer<typeof smsLoginBody>;

export const smsLoginResult = storefrontSession.extend({
  /** `true` when this call created the account. */
  registered: z.boolean(),
});
export type SmsLoginResult = z.infer<typeof smsLoginResult>;

export const registerBody = z.object({
  phone: phoneNumber,
  code: smsCode,
  password: newPassword(6),
  nickname: z.string().min(1).max(64).optional(),
});
export type RegisterBody = z.infer<typeof registerBody>;

export const resetPasswordBody = z.object({
  phone: phoneNumber,
  code: smsCode,
  password: newPassword(6),
});
export type ResetPasswordBody = z.infer<typeof resetPasswordBody>;

/**
 * Change the password of the account you are signed in as.
 *
 * Either proof works: the old password, or a fresh SMS code to the bound
 * number. An account created by WeChat has no password to quote, and refusing
 * to let it ever set one would leave accounts that can only be reached from
 * inside WeChat forever.
 */
export const changePasswordBody = z
  .object({
    oldPassword: z.string().min(1).max(128).optional(),
    code: smsCode.optional(),
    password: newPassword(6),
  })
  .superRefine((value, ctx) => {
    if (!value.oldPassword && !value.code) {
      ctx.addIssue({ code: 'custom', path: ['oldPassword'], message: '请填写原密码或短信验证码' });
    }
  });
export type ChangePasswordBody = z.infer<typeof changePasswordBody>;

export const okResult = z.object({ ok: z.literal(true) });

export const logoutEverywhereResult = z.object({
  /** Sessions killed, including the one that made the call. */
  revoked: z.number().int().min(0),
});
export type LogoutEverywhereResult = z.infer<typeof logoutEverywhereResult>;

// ---------------------------------------------------------------------------
// phone binding
// ---------------------------------------------------------------------------

/**
 * Bind or rebind the phone number.
 *
 * Rebinding needs a code sent to the **new** number only. Requiring one on the
 * old number too reads well on a whiteboard and locks out every customer who
 * changed carrier, which is the entire population this screen exists for.
 */
export const bindPhoneBody = z.object({
  phone: phoneNumber,
  code: smsCode,
});
export type BindPhoneBody = z.infer<typeof bindPhoneBody>;

// ---------------------------------------------------------------------------
// WeChat
// ---------------------------------------------------------------------------

/**
 * The result of a WeChat sign-in attempt.
 *
 * Flat rather than a discriminated union: `zod-to-openapi` renders a union as
 * `anyOf`, and the generated TanStack client then hands the caller a type it
 * has to narrow by hand at every call site. `status` is the discriminator and
 * the two payload fields are nullable.
 *
 * `phone-required` means the openid resolved but no account is bound to it and
 * the shop requires a phone number. `bindToken` stands in for the openid for a
 * few minutes so the second call does not have to redeem the WeChat `code`
 * again — WeChat codes are single-use, and redeeming one twice sends the
 * shopper round a "re-authorise and try again" loop.
 */
export const wechatLoginResult = z.object({
  status: z.enum(['signed-in', 'phone-required']),
  session: storefrontSession.nullable(),
  registered: z.boolean(),
  /** Set iff `status = 'phone-required'`. Single-use, short-lived. */
  bindToken: z.string().nullable(),
  bindTokenExpiresInSec: z.number().int().min(0).nullable(),
});
export type WechatLoginResult = z.infer<typeof wechatLoginResult>;

export const miniLoginBody = z.object({
  /** `wx.login()`'s code. Single-use, valid ~5 minutes. */
  code: z.string().min(1).max(512),
});
export type MiniLoginBody = z.infer<typeof miniLoginBody>;

/**
 * Finish a mini-program sign-in with the phone number.
 *
 * `phoneCode` is what `getPhoneNumber`'s callback gives in the current API — a
 * code redeemed server-side, not `encryptedData` + `iv`. There is no
 * client-side decryption path: it would need `session_key` to leave the server.
 */
export const miniPhoneLoginBody = z.object({
  bindToken: z.string().min(1).max(256),
  phoneCode: z.string().min(1).max(512),
});
export type MiniPhoneLoginBody = z.infer<typeof miniPhoneLoginBody>;

/**
 * Bind a number to the account that is **already signed in**, from inside the
 * mini program.
 *
 * The sibling of `bindPhoneBody` for a shopper who got in some other way and
 * then taps 微信授权手机号 in 个人中心: no `bindToken`, because there is a
 * session, and no SMS code, because WeChat has already verified the number —
 * asking for one as well would cost the shop a message to prove something the
 * platform just proved, and cost the shopper the one screen this button exists
 * to avoid.
 */
export const miniBindPhoneBody = z.object({
  /** The `code` from `getPhoneNumber`'s callback. Single-use, redeemed server-side. */
  phoneCode: z.string().min(1).max(512),
});
export type MiniBindPhoneBody = z.infer<typeof miniBindPhoneBody>;

export const oaLoginBody = z.object({
  /** The `code` on the OAuth redirect back from WeChat. */
  code: z.string().min(1).max(512),
});
export type OaLoginBody = z.infer<typeof oaLoginBody>;

/** Finish an OA sign-in by binding a phone number verified with an SMS code. */
export const wechatBindPhoneBody = z.object({
  bindToken: z.string().min(1).max(256),
  phone: phoneNumber,
  code: smsCode,
});
export type WechatBindPhoneBody = z.infer<typeof wechatBindPhoneBody>;

export const oaAuthorizeUrlQuery = z.object({
  /** Where WeChat sends the browser back. Must be inside the configured site host. */
  redirectUrl: z.string().min(1).max(512),
  /** `base` gets an openid only; `userinfo` shows the consent screen. */
  scope: z.enum(['base', 'userinfo']).default('base'),
});
export type OaAuthorizeUrlQuery = z.infer<typeof oaAuthorizeUrlQuery>;

export const oaAuthorizeUrlResult = z.object({
  url: z.string(),
  /** Echoed back by WeChat; the client must compare it before posting the code. */
  state: z.string(),
});
export type OaAuthorizeUrlResult = z.infer<typeof oaAuthorizeUrlResult>;

// ---------------------------------------------------------------------------
// examples
// ---------------------------------------------------------------------------

const TOKEN = 'u_8f2b7c1d9e4a6053f1b2c3d4e5f60718293a4b5c6d7e8f90';

export const storefrontSessionExample: StorefrontSession = {
  token: TOKEN,
  expiresAt: '2026-10-22T10:00:00+08:00',
  user: userProfileExample,
};

export const wechatUserProfileExample: UserProfile = {
  ...userProfileExample,
  id: '1002',
  account: 'wx_2b7c1d9e',
  registerSource: 'wechat_mini',
  hasPassword: false,
  boundWechat: ['mini'],
};
