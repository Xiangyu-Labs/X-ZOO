import type { ClientPlatform } from '@shop/contracts/conventions';
import type {
  BindPhoneBody,
  ChangePasswordBody,
  LogoutEverywhereResult,
  OaAuthorizeUrlQuery,
  OaLoginBody,
  MiniBindPhoneBody,
  MiniLoginBody,
  MiniPhoneLoginBody,
  PasswordLoginBody,
  RegisterBody,
  ResetPasswordBody,
  SendSmsCodeBody,
  SendSmsCodeResult,
  SmsLoginBody,
  SmsLoginResult,
  StorefrontSession,
  WechatBindPhoneBody,
  WechatLoginResult,
} from '@shop/contracts/auth/storefront-schemas';
import type { Tx } from '@shop/db';
import { captchaRequired, getCaptchaVerifier } from '../auth/captcha';
import { hashPassword, verifyAgainstNothing, verifyPassword } from '../auth/password';
import { UserSessionService } from '../auth/user-session.service';
import * as coupon from '../coupon';
import { DAY } from '../kernel/clock';
import { requireUserId, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { randomToken } from '../kernel/ids';
import { fixedWindow, resetFixedWindow } from '../kernel/rate-limit';
import { sendVerificationCode, verifyCode } from '../sms';
import { wechatMiniConfig, wechatOaConfig } from '../system';
import { wechatConfig } from '../wechat';
import { storefrontAuthConfig, type StorefrontAuthConfig } from './storefront-auth.config';
import { getWechatIdentityPort, type WechatIdentityPort } from './wechat-identity.port';
import {
  checkPasswordShape,
  defaultNickname,
  isSyntheticAccount,
  syntheticAccount,
  toPasswordAlgo,
} from './user.rules';
import * as repo from './user.repo';
import { toProfile } from './user.service';

/**
 * Storefront sign-in — one generation of it.
 *
 * One token format, one notion of "bound", and no second generation for the
 * client to choose between at runtime.
 *
 * Four rules hold throughout:
 *
 *  1. **A code is consumed atomically.** `verifyCode` runs one Lua script that
 *     compares, deletes and counts, so the same code cannot log two callers in.
 *  2. **Any password or status change bumps `password_version`**, which is what
 *     a live session is checked against — so it really does log every device
 *     out, in the same statement that changed the password.
 *  3. **No account enumeration.** A wrong account, a wrong password and an
 *     account with no password set all answer `AUTH_INVALID_CREDENTIALS`;
 *     `POST /auth/sms-codes` answers the same for a known and an unknown
 *     number.
 *  4. **A disabled account is only detectable with the right credentials.**
 *     The status check comes after the password check, never before.
 */

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

/** What the route layer knows about the caller and the domain does not. */
export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** How long a WeChat sign-in may sit half-finished waiting for a phone number. */
const BIND_TOKEN_TTL_MS = 10 * 60 * 1000;

async function settings(ctx: Ctx): Promise<StorefrontAuthConfig> {
  return ctx.config.get(storefrontAuthConfig);
}

function sessionService(config: StorefrontAuthConfig): UserSessionService {
  return new UserSessionService(config.sessionTtlDays * DAY);
}

/** `X-Client-Platform` is optional; a session still has to record something. */
function platformOf(ctx: Ctx): ClientPlatform {
  return ctx.platform ?? 'h5';
}

/** The platform as `users.register_source` spells it. */
function registerSourceOf(ctx: Ctx): 'h5' | 'wechat_oa' | 'wechat_mini' {
  switch (ctx.platform) {
    case 'wechat-oa':
      return 'wechat_oa';
    case 'wechat-mini':
      return 'wechat_mini';
    default:
      return 'h5';
  }
}

async function issueSession(
  ctx: Ctx,
  user: repo.UserRow,
  meta: RequestMeta,
): Promise<StorefrontSession> {
  const config = await settings(ctx);
  const issued = await sessionService(config).issue(ctx, {
    userId: user.id,
    passwordVersion: user.passwordVersion,
    platform: platformOf(ctx),
    userAgent: meta.userAgent ?? null,
  });
  await repo.touchLastLogin(ctx.db, { id: user.id, ip: meta.ip ?? null, now: ctx.clock.now() });
  const platforms = await repo.listPlatformsForUser(ctx.db, user.id);
  return {
    token: issued.token,
    expiresAt: issued.expiresAt.toISOString(),
    user: toProfile(user, platforms),
  };
}

/** `active` and not cancelled. Checked only after credentials have been proven. */
function assertUsable(user: repo.UserRow): void {
  if (user.status !== 'active' || user.deletedAt !== null) {
    throw new DomainError('USER_DISABLED');
  }
}

async function reload(ctx: Ctx, id: number): Promise<repo.UserRow> {
  const row = await repo.findById(ctx.db, id);
  if (!row) throw new DomainError('USER_NOT_FOUND');
  return row;
}

// ---------------------------------------------------------------------------
// SMS codes
// ---------------------------------------------------------------------------

/**
 * Send a verification code.
 *
 * The answer is identical for a registered and an unregistered number. Refusing
 * with 手机号已注册 on `scene=register` would turn the login screen into a free
 * "is this person your customer" oracle for anybody holding a phone book.
 *
 * The two scenes that act on the *current* account (`bind-phone`,
 * `change-phone`) do require a session — there is nothing to enumerate there
 * and an anonymous caller has no business minting one.
 */
export async function sendSmsCode(
  ctx: Ctx,
  body: SendSmsCodeBody,
  meta: RequestMeta = {},
): Promise<SendSmsCodeResult> {
  if (body.scene === 'bind-phone' || body.scene === 'change-phone') requireUserId(ctx);

  const config = await settings(ctx);
  const verifier = getCaptchaVerifier();
  if (verifier && captchaRequired({ failedAttempts: Number.MAX_SAFE_INTEGER })) {
    // Unlike login, there is no "after N failures" here: an SMS costs money on
    // the first request, so the captcha — once one is registered — is asked for
    // every time.
    if (!body.captchaToken) throw new DomainError('AUTH_CAPTCHA_REQUIRED');
    const passed = await verifier.verify(body.captchaToken, { subject: body.phone });
    if (!passed) throw new DomainError('AUTH_CAPTCHA_INVALID');
  }

  return sendVerificationCode(ctx, {
    scene: body.scene,
    phone: body.phone,
    ip: meta.ip ?? null,
    ttlMs: config.codeTtlSec * 1000,
    resendMs: config.codeResendSec * 1000,
    perIpPerDay: config.codePerIpPerDay,
  });
}

// ---------------------------------------------------------------------------
// password login
// ---------------------------------------------------------------------------

/**
 * Two throttle counters with two budgets: the caller's, and the account's.
 *
 * Everything reaches this app through one reverse proxy, so an IP-only bucket
 * would throttle the whole shop the moment one customer fat-fingers a password.
 * An account-only bucket at the same small limit let anybody lock a shopper out
 * of their own account with five wrong passwords. So `account+ip` gets
 * `loginMaxAttempts` — one machine guessing is parked quickly — and the account
 * alone gets ten times that: only guesses from many addresses at once, a
 * distributed attack rather than a nuisance, park the account. Without an
 * address (a dev server, a test) there is only the account, at the small
 * limit. The admin sign-in works the same way (`AdminAuthService`).
 */
const ACCOUNT_CEILING_FACTOR = 10;

function throttleKeys(
  account: string,
  ip: string | null | undefined,
  maxAttempts: number,
): { caller: string; account: { key: string; limit: number } | null; callerLimit: number } {
  const subject = `user:login:fail:${account.trim().toLowerCase()}`;
  return ip
    ? {
        caller: `${subject}:${ip}`,
        callerLimit: maxAttempts,
        account: { key: subject, limit: maxAttempts * ACCOUNT_CEILING_FACTOR },
      }
    : { caller: subject, callerLimit: maxAttempts, account: null };
}

/**
 * Account (or phone) and password. With `bindToken`, the password also
 * finishes a parked WeChat sign-in by linking its openid to the account
 * (AUTH-009); the throttle, the captcha, the password check and the session
 * are exactly what they are without it.
 */
export async function passwordLogin(
  ctx: Ctx,
  body: PasswordLoginBody,
  meta: RequestMeta = {},
): Promise<StorefrontSession> {
  const config = await settings(ctx);
  const keys = throttleKeys(body.account, meta.ip, config.loginMaxAttempts);
  const windowMs = config.loginWindowSec * 1000;

  const throttle = await fixedWindow(ctx.redis, {
    key: keys.caller,
    limit: keys.callerLimit,
    windowMs,
    nowMs: ctx.clock.nowMs(),
  });
  if (!throttle.allowed) {
    throw new DomainError('AUTH_TOO_MANY_ATTEMPTS', {
      details: { retryAfterMs: throttle.retryAfterMs },
    });
  }
  if (keys.account) {
    const ceiling = await fixedWindow(ctx.redis, {
      key: keys.account.key,
      limit: keys.account.limit,
      windowMs,
      nowMs: ctx.clock.nowMs(),
    });
    if (!ceiling.allowed) {
      throw new DomainError('AUTH_TOO_MANY_ATTEMPTS', {
        details: { retryAfterMs: ceiling.retryAfterMs },
      });
    }
  }

  const verifier = getCaptchaVerifier();
  const failedSoFar = keys.callerLimit - throttle.remaining - 1;
  if (verifier && captchaRequired({ failedAttempts: failedSoFar })) {
    if (!body.captchaToken) throw new DomainError('AUTH_CAPTCHA_REQUIRED');
    const passed = await verifier.verify(body.captchaToken, {
      subject: body.account.trim().toLowerCase(),
    });
    if (!passed) throw new DomainError('AUTH_CAPTCHA_INVALID');
  }

  const user = await repo.findByAccountOrPhone(ctx.db, body.account);
  // A missing account, a WeChat-only account with no password, and a wrong
  // password are one error with one shape. `AUTH_PASSWORD_NOT_SET` exists for
  // the *signed-in* 修改密码 screen, where the account is already known.
  // The same bcrypt work either way, so the timing does not list the accounts.
  if (!user || user.passwordHash === null) {
    await verifyAgainstNothing(body.password);
    throw new DomainError('AUTH_INVALID_CREDENTIALS');
  }

  const verified = await verifyPassword(
    body.password,
    user.passwordHash,
    toPasswordAlgo(user.passwordAlgo),
  );
  if (!verified.ok) throw new DomainError('AUTH_INVALID_CREDENTIALS');
  assertUsable(user);

  if (verified.needsUpgrade) {
    // Rewrites `md5_legacy` as bcrypt, conditional on the hash we just verified
    // and *without* bumping `password_version` — the password did not change,
    // and bumping would log the customer out of their other devices as a side
    // effect of logging in here.
    const upgraded = await hashPassword(body.password);
    const result = await repo.upgradePasswordHash(ctx.db, {
      id: user.id,
      fromHash: user.passwordHash,
      toHash: upgraded,
      now: ctx.clock.now(),
    });
    if (result.won) ctx.logger.info({ userId: user.id }, '已将遗留 MD5 密码升级为 bcrypt');
  }

  // The caller's counter only: a guesser's progress against the account is not
  // wiped by the owner signing in.
  await resetFixedWindow(ctx.redis, keys.caller);
  if (body.bindToken) await linkPendingToAccount(ctx, user.id, body.bindToken);
  return issueSession(ctx, user, meta);
}

// ---------------------------------------------------------------------------
// SMS login (and the registration hiding inside it)
// ---------------------------------------------------------------------------

/**
 * Code login, which registers when the number is new.
 *
 * Holding a code sent to the number *is* the proof of ownership a registration
 * needs, so there is nothing left to ask; a separate registration form asking
 * for the same number and code again loses most shoppers.
 */
export async function smsLogin(
  ctx: Ctx,
  body: SmsLoginBody,
  meta: RequestMeta = {},
): Promise<SmsLoginResult> {
  const config = await settings(ctx);
  await verifyCode(ctx, {
    scene: 'login',
    phone: body.phone,
    code: body.code,
    maxAttempts: config.codeMaxAttempts,
  });

  const existing = await repo.findByPhone(ctx.db, body.phone);
  if (existing) {
    assertUsable(existing);
    return { ...(await issueSession(ctx, existing, meta)), registered: false };
  }

  const created = await ctx.withTx((tx) =>
    createUser(tx, ctx, {
      account: body.phone,
      phone: body.phone,
      passwordHash: null,
      nickname: defaultNickname(body.phone),
      avatarUrl: config.defaultAvatar || null,
      registerIp: meta.ip ?? null,
    }),
  );
  assertUsable(created.user);
  return { ...(await issueSession(ctx, created.user, meta)), registered: created.created };
}

/**
 * Create a customer, or find the one a concurrent request just created.
 *
 * `insertUser` returns `null` when `users_phone_lower_uq` refused, which is the
 * only reliable answer under concurrency: two taps of 登录 on a flaky
 * connection, or two app instances, reach this at the same instant and the
 * database decides. The loser reads the winner's row and signs in to it, so one
 * phone number is one account and neither caller sees an error.
 *
 * The welcome coupons are granted **inside** the transaction that created the
 * row: a registration that rolls back must not leave coupons behind, and one
 * that commits must not need a second request to earn them.
 */
async function createUser(
  tx: Tx,
  ctx: Ctx,
  input: {
    account: string;
    phone: string | null;
    passwordHash: string | null;
    nickname: string | null;
    avatarUrl: string | null;
    registerIp: string | null;
  },
): Promise<{ user: repo.UserRow; created: boolean }> {
  const now = ctx.clock.now();
  const inserted = await repo.insertUser(tx, {
    account: input.account,
    phone: input.phone,
    passwordHash: input.passwordHash,
    passwordAlgo: input.passwordHash === null ? null : 'bcrypt',
    nickname: input.nickname,
    avatarUrl: input.avatarUrl,
    registerSource: registerSourceOf(ctx),
    registerIp: input.registerIp,
    now,
  });

  if (!inserted) {
    const raced =
      (input.phone !== null ? await repo.findByPhone(tx, input.phone) : null) ??
      (await repo.findByAccountOrPhone(tx, input.account));
    if (!raced) throw new DomainError('AUTH_PHONE_TAKEN');
    return { user: raced, created: false };
  }

  await coupon.grantNewUser(tx, ctx, inserted.id);
  ctx.logger.info({ userId: inserted.id, source: registerSourceOf(ctx) }, '新用户注册');
  return { user: inserted, created: true };
}

// ---------------------------------------------------------------------------
// registration, password reset, password change
// ---------------------------------------------------------------------------

export async function register(
  ctx: Ctx,
  body: RegisterBody,
  meta: RequestMeta = {},
): Promise<SmsLoginResult> {
  const config = await settings(ctx);
  assertPassword(body.password);
  await verifyCode(ctx, {
    scene: 'register',
    phone: body.phone,
    code: body.code,
    maxAttempts: config.codeMaxAttempts,
  });

  const hash = await hashPassword(body.password);
  const outcome = await ctx.withTx((tx) =>
    createUser(tx, ctx, {
      account: body.phone,
      phone: body.phone,
      passwordHash: hash,
      nickname: body.nickname ?? defaultNickname(body.phone),
      avatarUrl: config.defaultAvatar || null,
      registerIp: meta.ip ?? null,
    }),
  );
  // Here, unlike `smsLogin`, losing the race is a real error: the caller asked
  // to *register* this number and it already belongs to somebody.
  if (!outcome.created) throw new DomainError('AUTH_PHONE_TAKEN');
  assertUsable(outcome.user);
  return { ...(await issueSession(ctx, outcome.user, meta)), registered: true };
}

/**
 * Forgotten password.
 *
 * Holding a code sent to the bound number is the proof; there is nothing else
 * to check. The version bump inside `setPassword` kills every live session, and
 * the explicit revoke marks the rows so they stop being resolved before the
 * housekeeping sweep runs.
 */
export async function resetPassword(ctx: Ctx, body: ResetPasswordBody): Promise<{ ok: true }> {
  const config = await settings(ctx);
  assertPassword(body.password);
  await verifyCode(ctx, {
    scene: 'reset-password',
    phone: body.phone,
    code: body.code,
    maxAttempts: config.codeMaxAttempts,
  });

  const user = await repo.findByPhone(ctx.db, body.phone);
  if (!user) throw new DomainError('USER_NOT_FOUND');
  await applyNewPassword(ctx, user, body.password);
  return { ok: true };
}

/**
 * Change the password of the account you are signed in as.
 *
 * Either proof works. An account created by WeChat or by SMS code has no
 * password to quote, and refusing to let it ever set one would leave accounts
 * reachable only from inside WeChat, forever.
 *
 * Every session dies, including the one making the call. That is the point of
 * the feature — a customer changes their password because they think somebody
 * else has it — so the client signs in again with the new one.
 */
export async function changePassword(ctx: Ctx, body: ChangePasswordBody): Promise<{ ok: true }> {
  const userId = requireUserId(ctx);
  const config = await settings(ctx);
  assertPassword(body.password);

  const user = await reload(ctx, userId);
  assertUsable(user);

  if (body.oldPassword !== undefined) {
    if (user.passwordHash === null) throw new DomainError('AUTH_PASSWORD_NOT_SET');
    const verified = await verifyPassword(
      body.oldPassword,
      user.passwordHash,
      toPasswordAlgo(user.passwordAlgo),
    );
    if (!verified.ok) throw new DomainError('AUTH_OLD_PASSWORD_INVALID');
    const same = await verifyPassword(
      body.password,
      user.passwordHash,
      toPasswordAlgo(user.passwordAlgo),
    );
    if (same.ok) throw new DomainError('AUTH_PASSWORD_UNCHANGED');
  } else if (body.code !== undefined) {
    if (user.phone === null) throw new DomainError('AUTH_PHONE_NOT_BOUND');
    await verifyCode(ctx, {
      scene: 'reset-password',
      phone: user.phone,
      code: body.code,
      maxAttempts: config.codeMaxAttempts,
    });
  } else {
    // zod's `superRefine` already rejects this; the branch keeps the service
    // honest when it is called from a test or a job rather than through a route.
    throw new DomainError('VALIDATION_FAILED');
  }

  await applyNewPassword(ctx, user, body.password);
  return { ok: true };
}

async function applyNewPassword(ctx: Ctx, user: repo.UserRow, plain: string): Promise<void> {
  const hash = await hashPassword(plain);
  await ctx.withTx(async (tx) => {
    const result = await repo.setPassword(tx, {
      id: user.id,
      hash,
      now: ctx.clock.now(),
    });
    if (!result.won) throw new DomainError('USER_NOT_FOUND');
  });
  const config = await settings(ctx);
  const revoked = await sessionService(config).revokeAllForUser(ctx, user.id);
  ctx.logger.info({ userId: user.id, revoked }, '密码已修改，所有会话失效');
}

function assertPassword(plain: string): void {
  switch (checkPasswordShape(plain)) {
    case 'ok':
      return;
    case 'too-short':
      throw new DomainError('VALIDATION_FAILED', {
        details: [{ field: 'body.password', message: '密码至少 6 位' }],
      });
    case 'too-long':
      throw new DomainError('VALIDATION_FAILED', {
        details: [{ field: 'body.password', message: '密码过长（上限 72 字节）' }],
      });
    case 'too-simple':
      throw new DomainError('VALIDATION_FAILED', {
        details: [{ field: 'body.password', message: '密码需包含字母、数字或符号中的至少两类' }],
      });
  }
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

export async function logout(ctx: Ctx, token: string): Promise<{ ok: true }> {
  const config = await settings(ctx);
  await sessionService(config).revoke(ctx, token);
  return { ok: true };
}

export async function logoutEverywhere(ctx: Ctx): Promise<LogoutEverywhereResult> {
  const userId = requireUserId(ctx);
  const config = await settings(ctx);
  const revoked = await sessionService(config).revokeAllForUser(ctx, userId);
  return { revoked };
}

// ---------------------------------------------------------------------------
// phone binding
// ---------------------------------------------------------------------------

/**
 * Add a number to an account that has none.
 *
 * The answer is `{ ok: true }`, not a fresh session: binding does not bump
 * `password_version`, so the caller's token is still valid, and minting a second
 * one would leave a session row nobody ever holds. The client refetches the
 * profile, which is where the number belongs anyway.
 */
export async function bindPhone(ctx: Ctx, body: BindPhoneBody): Promise<{ ok: true }> {
  const userId = requireUserId(ctx);
  const config = await settings(ctx);
  const user = await reload(ctx, userId);
  assertUsable(user);
  if (user.phone !== null) throw new DomainError('AUTH_PHONE_ALREADY_BOUND');

  await verifyCode(ctx, {
    scene: 'bind-phone',
    phone: body.phone,
    code: body.code,
    maxAttempts: config.codeMaxAttempts,
  });
  await attachPhone(ctx, user, body.phone, null);
  return { ok: true };
}

/**
 * The same, with WeChat's word for the number instead of an SMS code.
 *
 * 微信授权手机号 inside the mini program: the shopper taps a button, WeChat
 * hands the client a single-use `code`, and the number comes back over a
 * server-to-server call. No SMS is sent — the shop would be paying to prove
 * something the platform has just proved — and the number is never taken from
 * the request body, which is the whole point of the exchange.
 *
 * Everything after that is `bindPhone`'s path, including `attachPhone`'s
 * conditional update: a shopper who binds from two devices at once, or binds a
 * number another account already holds, is refused there rather than here.
 * `AUTH_PHONE_ALREADY_BOUND` is checked first all the same, so a double tap
 * does not burn the WeChat code before finding out there was nothing to do.
 */
export async function bindPhoneFromMini(ctx: Ctx, body: MiniBindPhoneBody): Promise<{ ok: true }> {
  const userId = requireUserId(ctx);
  const user = await reload(ctx, userId);
  assertUsable(user);
  if (user.phone !== null) throw new DomainError('AUTH_PHONE_ALREADY_BOUND');

  const mini = await miniApp(ctx);
  if (!mini.enabled) throw new DomainError('AUTH_WECHAT_NOT_CONFIGURED');

  const number = await wechatPort().miniPhoneNumber(ctx, body.phoneCode);
  await attachPhone(ctx, user, number.phone, null);
  return { ok: true };
}

/**
 * Rebind.
 *
 * A code on the **new** number only. Demanding one on the old number too reads
 * well on a whiteboard and locks out every customer who changed carrier or lost
 * the handset — which is the entire population this screen exists for.
 */
export async function changePhone(ctx: Ctx, body: BindPhoneBody): Promise<{ ok: true }> {
  const userId = requireUserId(ctx);
  const config = await settings(ctx);
  const user = await reload(ctx, userId);
  assertUsable(user);
  if (user.phone === null) throw new DomainError('AUTH_PHONE_NOT_BOUND');
  // Rebinding to the number already on file is a no-op, not an error: a
  // double-submitted form must not cost the shopper a code.
  if (user.phone === body.phone) return { ok: true };

  await verifyCode(ctx, {
    scene: 'change-phone',
    phone: body.phone,
    code: body.code,
    maxAttempts: config.codeMaxAttempts,
  });
  await attachPhone(ctx, user, body.phone, user.phone);
  return { ok: true };
}

/**
 * Point an account at a phone number.
 *
 * The account name follows the number when it is still the synthetic `wx_…`
 * one, so a WeChat shopper who binds their number can afterwards sign in with
 * it and a password. An account name somebody chose is left alone.
 */
async function attachPhone(
  ctx: Ctx,
  user: repo.UserRow,
  phone: string,
  expect: string | null,
): Promise<void> {
  await ctx.withTx(async (tx) => {
    const holder = await repo.findByPhone(tx, phone);
    if (holder && holder.id !== user.id) throw new DomainError('AUTH_PHONE_TAKEN');
    const result = await repo.bindPhone(tx, {
      id: user.id,
      phone,
      alsoSetAccount: isSyntheticAccount(user.account),
      expectPhone: expect,
      now: ctx.clock.now(),
    });
    // Lost to a concurrent bind on the same account, or the unique index
    // refused because somebody else took the number a microsecond ago.
    if (!result.won) throw new DomainError('AUTH_PHONE_TAKEN');
  });
}

// ---------------------------------------------------------------------------
// WeChat
// ---------------------------------------------------------------------------

function wechatPort(): WechatIdentityPort {
  const port = getWechatIdentityPort();
  // Fail closed. A missing adapter means the WeChat client did not load, and
  // the alternative — signing somebody in without having talked to WeChat — is
  // not a degraded mode, it is an authentication bypass.
  if (!port) throw new DomainError('AUTH_WECHAT_NOT_CONFIGURED');
  return port;
}

interface PendingWechat {
  platform: 'oa' | 'mini';
  openid: string;
  unionid: string | null;
  nickname: string | null;
  avatarUrl: string | null;
}

const bindKey = (token: string): string => `wx:bind:${token}`;

/**
 * Park a resolved openid for a few minutes.
 *
 * WeChat `code`s are single-use and expire in minutes. Asking the client to
 * re-authorise between the sign-in call and the phone-number call produces a
 * "请重新授权" loop. Holding the resolved identity server-side under an opaque
 * token means the second call is one request, and the token is destroyed the
 * instant it is read.
 */
async function parkPending(ctx: Ctx, pending: PendingWechat): Promise<string> {
  const token = randomToken(32);
  await ctx.redis.set(bindKey(token), JSON.stringify(pending), 'PX', BIND_TOKEN_TTL_MS);
  return token;
}

async function takePending(ctx: Ctx, token: string): Promise<PendingWechat> {
  // `GETDEL`: read and destroy in one step, so two concurrent submissions of
  // the same bind token cannot both create an account.
  const raw = await ctx.redis.getdel(bindKey(token));
  if (!raw) throw new DomainError('AUTH_WECHAT_BIND_EXPIRED');
  return JSON.parse(raw) as PendingWechat;
}

/** Put a taken bind token back after a step that failed through no fault of the token. */
async function restorePending(ctx: Ctx, token: string, pending: PendingWechat): Promise<void> {
  await ctx.redis.set(bindKey(token), JSON.stringify(pending), 'PX', BIND_TOKEN_TTL_MS);
}

function phoneRequired(bindToken: string): WechatLoginResult {
  return {
    status: 'phone-required',
    session: null,
    registered: false,
    bindToken,
    bindTokenExpiresInSec: Math.round(BIND_TOKEN_TTL_MS / 1000),
  };
}

function signedIn(session: StorefrontSession, registered: boolean): WechatLoginResult {
  return {
    status: 'signed-in',
    session,
    registered,
    bindToken: null,
    bindTokenExpiresInSec: null,
  };
}

/**
 * The common half of both WeChat sign-ins.
 *
 * Resolution order: this openid → the same person's openid on the other WeChat
 * app (via `unionid`) → nobody. Checking the unionid matters: a shopper who
 * ordered in the Official Account and then opens the mini-program is the same
 * customer with the same orders, not a second, empty account.
 */
async function signInWithIdentity(
  ctx: Ctx,
  pending: PendingWechat,
  meta: RequestMeta,
): Promise<WechatLoginResult> {
  const config = await settings(ctx);

  const identity = await repo.findIdentityByOpenid(ctx.db, {
    platform: pending.platform,
    openid: pending.openid,
  });
  if (identity) {
    const user = await reload(ctx, identity.userId);
    assertUsable(user);
    return signedIn(await issueSession(ctx, user, meta), false);
  }

  if (pending.unionid) {
    const sibling = await repo.findIdentityByUnionid(ctx.db, pending.unionid);
    if (sibling) {
      const user = await reload(ctx, sibling.userId);
      assertUsable(user);
      await ctx.withTx((tx) => linkIdentity(tx, ctx, user.id, pending));
      return signedIn(await issueSession(ctx, user, meta), false);
    }
  }

  if (config.requirePhoneForWechat) {
    return phoneRequired(await parkPending(ctx, pending));
  }

  // Phone-free mode: an openid alone becomes an account. Convenient, and it
  // makes a support ticket unanswerable, which is why the default is off.
  let created: Awaited<ReturnType<typeof createUser>>;
  try {
    created = await ctx.withTx(async (tx) => {
      const outcome = await createUser(tx, ctx, {
        account: syntheticAccount(),
        phone: null,
        passwordHash: null,
        nickname: pending.nickname ?? defaultNickname(null),
        avatarUrl: pending.avatarUrl ?? (config.defaultAvatar || null),
        registerIp: meta.ip ?? null,
      });
      await linkIdentity(tx, ctx, outcome.user.id, pending);
      return outcome;
    });
  } catch (error) {
    return signInAfterIdentityRace(ctx, pending, meta, error);
  }
  assertUsable(created.user);
  return signedIn(await issueSession(ctx, created.user, meta), created.created);
}

/**
 * The loser of a WeChat sign-in that two taps started at the same instant.
 *
 * Both callers looked, saw no identity row, and went on to create one; the
 * openid index let exactly one commit and rolled the other's account back along
 * with it. That is not something to show a shopper — the account they were
 * about to create exists now, and it is theirs — so the loser re-reads the
 * winner's identity and signs in to it. No row means the refusal was the other
 * index (this account already has an identity on this WeChat app), which is a
 * real refusal and is re-thrown.
 */
async function signInAfterIdentityRace(
  ctx: Ctx,
  pending: PendingWechat,
  meta: RequestMeta,
  error: unknown,
): Promise<WechatLoginResult> {
  if (!(error instanceof DomainError) || error.code !== 'AUTH_WECHAT_ALREADY_BOUND') throw error;
  const winner = await repo.findIdentityByOpenid(ctx.db, {
    platform: pending.platform,
    openid: pending.openid,
  });
  if (!winner) throw error;
  const user = await reload(ctx, winner.userId);
  assertUsable(user);
  return signedIn(await issueSession(ctx, user, meta), false);
}

async function linkIdentity(
  tx: Tx,
  ctx: Ctx,
  userId: number,
  pending: PendingWechat,
): Promise<void> {
  const row = await repo.insertIdentity(tx, {
    userId,
    platform: pending.platform,
    openid: pending.openid,
    unionid: pending.unionid,
    nickname: pending.nickname,
    avatarUrl: pending.avatarUrl,
    now: ctx.clock.now(),
  });
  // `null` means one of the two unique indexes refused: this openid already
  // belongs to somebody, or this account already has an identity on this app.
  if (!row) throw new DomainError('AUTH_WECHAT_ALREADY_BOUND');
}

/**
 * Finish a parked sign-in with the password of an existing account (AUTH-009).
 *
 * Called only after the password has been verified and the account found
 * usable, so a wrong password never touches the token. The link is the one
 * `completeWithPhone` makes for a registered number, and it fails the same
 * way: a spent token is `AUTH_WECHAT_BIND_EXPIRED`, a taken openid (or an
 * account that already has an identity on that app) `AUTH_WECHAT_ALREADY_BOUND`,
 * and the token is not put back after a refused link.
 */
async function linkPendingToAccount(ctx: Ctx, userId: number, bindToken: string): Promise<void> {
  const pending = await takePending(ctx, bindToken);
  await ctx.withTx((tx) => linkIdentity(tx, ctx, userId, pending));
}

/** Finish a parked sign-in with a verified phone number. */
async function completeWithPhone(
  ctx: Ctx,
  pending: PendingWechat,
  phone: string,
  meta: RequestMeta,
): Promise<WechatLoginResult> {
  const config = await settings(ctx);
  const existing = await repo.findByPhone(ctx.db, phone);

  if (existing) {
    assertUsable(existing);
    await ctx.withTx((tx) => linkIdentity(tx, ctx, existing.id, pending));
    return signedIn(await issueSession(ctx, await reload(ctx, existing.id), meta), false);
  }

  let created: Awaited<ReturnType<typeof createUser>>;
  try {
    created = await ctx.withTx(async (tx) => {
      const outcome = await createUser(tx, ctx, {
        account: phone,
        phone,
        passwordHash: null,
        nickname: pending.nickname ?? defaultNickname(phone),
        avatarUrl: pending.avatarUrl ?? (config.defaultAvatar || null),
        registerIp: meta.ip ?? null,
      });
      await linkIdentity(tx, ctx, outcome.user.id, pending);
      return outcome;
    });
  } catch (error) {
    return signInAfterIdentityRace(ctx, pending, meta, error);
  }
  assertUsable(created.user);
  return signedIn(await issueSession(ctx, created.user, meta), created.created);
}

/**
 * "Is there a mini program, and what is its app id."
 *
 * The same two-group split as `oaApp`, for the same reason: the `wechat-mini`
 * group holds the operator's 启用 switch, and every WeChat credential lives in
 * the `wechat` group (an app id claimed by both groups would show in one screen
 * and as a blank in the other).
 */
async function miniApp(ctx: Ctx): Promise<{ enabled: boolean; appId: string }> {
  const [mini, core] = await Promise.all([
    ctx.config.get(wechatMiniConfig),
    ctx.config.get(wechatConfig),
  ]);
  const appId = core.miniAppId.trim();
  return { enabled: mini.enabled && appId !== '', appId };
}

/**
 * Invalid `wx.login` codes one address may send per window before
 * `miniLogin` refuses it without asking WeChat.
 *
 * Only *failures* count. A real mini-program sends one valid code per launch,
 * and mobile carriers put thousands of phones behind one address, so counting
 * every sign-in would throttle a whole city at lunchtime. A flood of made-up
 * codes, on the other hand, is nobody's launch — and each one costs a
 * `code2Session` call against the shop's WeChat quota (AUTH-006).
 */
const MINI_CODE_FAILURES_PER_IP = 20;
const MINI_CODE_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const miniFailureKey = (ip: string): string => `user:mini-login:fail:${ip}`;

async function assertMiniCodeBudget(ctx: Ctx, ip: string | null): Promise<void> {
  if (!ip) return;
  const key = miniFailureKey(ip);
  const failures = Number((await ctx.redis.get(key)) ?? 0);
  if (failures < MINI_CODE_FAILURES_PER_IP) return;
  const ttl = await ctx.redis.pttl(key);
  throw new DomainError('RATE_LIMITED', {
    details: { retryAfterMs: ttl > 0 ? ttl : MINI_CODE_FAILURE_WINDOW_MS },
  });
}

/**
 * `wx.login()`'s code → a session, or `phone-required` and a bind token.
 *
 * This is also the mini-program's **silent renewal**: a client whose token
 * expired or was revoked (any 401) calls `wx.login()` again and posts the new
 * code here. A known openid is signed straight in — `status: 'signed-in'`,
 * `registered: false`, a fresh token of `sessionTtlDays`, the same account —
 * without showing the shopper anything. Other devices' sessions are left
 * alone. See `docs/mini/auth.md`.
 */
export async function miniLogin(
  ctx: Ctx,
  body: MiniLoginBody,
  meta: RequestMeta = {},
): Promise<WechatLoginResult> {
  const mini = await miniApp(ctx);
  if (!mini.enabled) throw new DomainError('AUTH_WECHAT_NOT_CONFIGURED');
  const ip = meta.ip ?? null;
  await assertMiniCodeBudget(ctx, ip);
  let session: Awaited<ReturnType<WechatIdentityPort['miniCodeToSession']>>;
  try {
    session = await wechatPort().miniCodeToSession(ctx, body.code);
  } catch (error) {
    if (ip && error instanceof DomainError && error.code === 'AUTH_WECHAT_CODE_INVALID') {
      await fixedWindow(ctx.redis, {
        key: miniFailureKey(ip),
        limit: MINI_CODE_FAILURES_PER_IP,
        windowMs: MINI_CODE_FAILURE_WINDOW_MS,
        nowMs: ctx.clock.now().getTime(),
      });
    }
    throw error;
  }
  return signInWithIdentity(
    ctx,
    {
      platform: 'mini',
      openid: session.openid,
      unionid: session.unionid ?? null,
      nickname: null,
      avatarUrl: null,
    },
    meta,
  );
}

/**
 * Finish a mini-program sign-in with `getPhoneNumber`.
 *
 * The phone number comes back from WeChat's own endpoint, which is proof of
 * ownership — so no SMS code is asked for, unlike the OA flow where the browser
 * can offer no such proof.
 *
 * If WeChat refuses the phone code (expired, already used, WeChat down) the
 * bind token is put back, exactly as `oaPhoneLogin` does for a mistyped SMS
 * code: the shopper can retry, or fall back to an SMS code on
 * `POST /auth/sessions/wechat-oa/phone` with the same token, without a fresh
 * `wx.login()` (AUTH-007).
 */
export async function miniPhoneLogin(
  ctx: Ctx,
  body: MiniPhoneLoginBody,
  meta: RequestMeta = {},
): Promise<WechatLoginResult> {
  const pending = await takePending(ctx, body.bindToken);
  let number: Awaited<ReturnType<WechatIdentityPort['miniPhoneNumber']>>;
  try {
    number = await wechatPort().miniPhoneNumber(ctx, body.phoneCode);
  } catch (error) {
    await restorePending(ctx, body.bindToken, pending);
    throw error;
  }
  return completeWithPhone(ctx, pending, number.phone, meta);
}

/**
 * "Is there an Official Account, and what is its app id."
 *
 * Two groups, on purpose: the `wechat-oa` group holds the operator's 启用
 * switch and the callback settings, while the app id lives in the `wechat`
 * group and nowhere else (an app id claimed by both groups would show in one
 * screen and as a blank in the other).
 */
async function oaApp(ctx: Ctx): Promise<{ enabled: boolean; appId: string }> {
  const [oa, core] = await Promise.all([
    ctx.config.get(wechatOaConfig),
    ctx.config.get(wechatConfig),
  ]);
  const appId = core.oaAppId.trim();
  return { enabled: oa.enabled && appId !== '', appId };
}

/**
 * The 公众号 authorisation URL.
 *
 * `redirectUrl` is checked against the configured `siteUrl` before it is handed
 * to WeChat. An unchecked redirect on this endpoint gives the `code` — and with
 * it the sign-in — to whoever asked for it, which is the classic OAuth open
 * redirect.
 */
export async function oaAuthorizeUrl(
  ctx: Ctx,
  query: OaAuthorizeUrlQuery,
): Promise<{ url: string; state: string }> {
  const oa = await oaApp(ctx);
  if (!oa.enabled) throw new DomainError('AUTH_WECHAT_NOT_CONFIGURED');
  const config = await settings(ctx);
  if (!isAllowedRedirect(query.redirectUrl, config.siteUrl)) {
    throw new DomainError('AUTH_REDIRECT_NOT_ALLOWED');
  }
  const state = randomToken(16);
  const scope = query.scope === 'userinfo' ? 'snsapi_userinfo' : 'snsapi_base';
  const url =
    'https://open.weixin.qq.com/connect/oauth2/authorize' +
    `?appid=${encodeURIComponent(oa.appId)}` +
    `&redirect_uri=${encodeURIComponent(query.redirectUrl)}` +
    '&response_type=code' +
    `&scope=${scope}` +
    `&state=${state}` +
    '#wechat_redirect';
  return { url, state };
}

/**
 * Same origin as the configured site, and nothing else.
 *
 * Compares parsed origins rather than `startsWith`, because
 * `https://shop.example.com.attacker.test` starts with the site URL.
 */
export function isAllowedRedirect(redirectUrl: string, siteUrl: string): boolean {
  if (!siteUrl) return false;
  try {
    const target = new URL(redirectUrl);
    const site = new URL(siteUrl);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;
    return target.origin === site.origin;
  } catch {
    return false;
  }
}

export async function oaLogin(
  ctx: Ctx,
  body: OaLoginBody,
  meta: RequestMeta = {},
): Promise<WechatLoginResult> {
  const oa = await oaApp(ctx);
  if (!oa.enabled) throw new DomainError('AUTH_WECHAT_NOT_CONFIGURED');
  const user = await wechatPort().oaCodeToUser(ctx, body.code);
  return signInWithIdentity(
    ctx,
    {
      platform: 'oa',
      openid: user.openid,
      unionid: user.unionid ?? null,
      nickname: user.nickname ?? null,
      avatarUrl: user.avatarUrl ?? null,
    },
    meta,
  );
}

/**
 * Finish an OA sign-in by binding a number verified with an SMS code.
 *
 * The scene is **`login`**, not `bind-phone`. The caller is anonymous — that is
 * what this route is for — and `sendSmsCode` refuses to mint a `bind-phone`
 * code without a session, because that scene means "add a number to the account
 * I am already signed in as". The privilege granted is the same one
 * `smsLogin` already grants for a `login` code: holding a code sent to the
 * number proves ownership of it.
 */
export async function oaPhoneLogin(
  ctx: Ctx,
  body: WechatBindPhoneBody,
  meta: RequestMeta = {},
): Promise<WechatLoginResult> {
  const config = await settings(ctx);
  const pending = await takePending(ctx, body.bindToken);
  try {
    await verifyCode(ctx, {
      scene: 'login',
      phone: body.phone,
      code: body.code,
      maxAttempts: config.codeMaxAttempts,
    });
  } catch (error) {
    // The bind token was already destroyed by `takePending`. Put it back so a
    // mistyped code does not cost the shopper a fresh WeChat authorisation.
    await restorePending(ctx, body.bindToken, pending);
    throw error;
  }
  return completeWithPhone(ctx, pending, body.phone, meta);
}
