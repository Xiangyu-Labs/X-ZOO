import type { z } from 'zod';
import { smsConfig } from '../system';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { fixedWindow } from '../kernel/rate-limit';
import { createAliyunSmsSender } from './sms-aliyun';
import { createTencentSmsSender } from './sms-tencent';
import {
  getSmsSenderOverride,
  nullSmsSender,
  type SmsSendResult,
  type SmsSender,
} from './sms.port';
import {
  claimResend,
  consumeCode,
  discardCode,
  generateCode,
  issueCode,
  releaseResend,
  type VerifyOutcome,
} from './verification-code';

/**
 * Sending an SMS, and verifying what came back.
 *
 * The domain owns three things and nothing else: which provider is live, the
 * budgets, and the atomic verification. Every policy number that belongs to a
 * *flow* (how long a login code lives, how many guesses it survives) is passed
 * in by the caller, because those are properties of the login screen and live
 * in the `storefront-auth` config group that the `user` domain owns.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type SmsConfigValues = z.infer<typeof smsConfig.schema>;

/**
 * Whether the `sms` group names a provider this build can send through.
 *
 * `resolveSender`'s rule, extracted so `GET /api/v1/app/config` can say
 * whether 手机号登录 works without a second copy of it to drift: Aliyun with
 * its key id, key secret and sign name all filled in, or Tencent with its
 * SdkAppId, SecretId, SecretKey and sign name. `none` is not.
 */
export function smsProviderConfigured(config: SmsConfigValues): boolean {
  if (config.provider === 'aliyun') {
    return (
      config.aliyunAccessKeyId !== '' &&
      config.aliyunAccessKeySecret !== '' &&
      config.aliyunSignName !== ''
    );
  }
  if (config.provider === 'tencent') {
    return (
      config.tencentAppId !== '' &&
      config.tencentSecretId !== '' &&
      config.tencentSecretKey !== '' &&
      config.tencentSignName !== ''
    );
  }
  return false;
}

/**
 * Whether `resolveSender` would hand back a sender that can deliver: a
 * registered one (tests, `SHOP_FAKE_SMS`), or a configured provider. Anything
 * else resolves to `nullSmsSender`, which refuses every send.
 */
export async function smsSenderUsable(ctx: Ctx): Promise<boolean> {
  if (getSmsSenderOverride()) return true;
  return smsProviderConfigured(await ctx.config.get(smsConfig));
}

/** The provider the `sms` group names, or `nullSmsSender` while it is incomplete. */
export async function resolveSender(ctx: Ctx): Promise<SmsSender> {
  const registered = getSmsSenderOverride();
  if (registered) return registered;

  return senderFor(ctx, await ctx.config.get(smsConfig));
}

/**
 * The provider a given set of `sms` values names — the stored ones, or the
 * unsaved form 「测试」 runs against.
 */
export function senderFor(ctx: Pick<Ctx, 'clock'>, config: SmsConfigValues): SmsSender {
  if (!smsProviderConfigured(config)) return nullSmsSender;
  if (config.provider === 'aliyun') {
    return createAliyunSmsSender({
      accessKeyId: config.aliyunAccessKeyId,
      accessKeySecret: config.aliyunAccessKeySecret,
      regionId: config.aliyunRegionId,
      signName: config.aliyunSignName,
      now: () => ctx.clock.now(),
    });
  }
  return createTencentSmsSender({
    sdkAppId: config.tencentAppId,
    secretId: config.tencentSecretId,
    secretKey: config.tencentSecretKey,
    signName: config.tencentSignName,
    region: config.tencentRegion || 'ap-guangzhou',
    now: () => ctx.clock.now(),
  });
}

export interface SendCodeOptions {
  scene: string;
  phone: string;
  /** For the per-IP daily budget. Omitted in jobs and tests. */
  ip?: string | null;
  ttlMs: number;
  resendMs: number;
  /** Per-IP daily cap; the per-phone caps come from the `sms` config group. */
  perIpPerDay: number;
}

export interface SendCodeResult {
  expiresInSec: number;
  resendAfterSec: number;
}

/**
 * Mint a code, store it, send it.
 *
 * Order matters. The resend window is **claimed first**, with one `SET NX`: of
 * any number of simultaneous taps, exactly one gets past this line, and the
 * others are told to wait without touching a budget. Then every budget is
 * checked before a code is minted, the code is stored before it is sent (so a
 * send that succeeds but whose response is lost still leaves a usable code),
 * and any refusal after the claim — a budget, the provider — hands the window
 * back, so the shopper is not told to wait 60 seconds for a code that was never
 * sent.
 */
export async function sendVerificationCode(
  ctx: Ctx,
  options: SendCodeOptions,
): Promise<SendCodeResult> {
  const { scene, phone } = options;
  const nowMs = ctx.clock.nowMs();

  const claim = await claimResend(ctx.redis, scene, phone, options.resendMs);
  if (claim.token === null) {
    throw new DomainError('AUTH_SMS_TOO_FREQUENT', { details: { retryAfterMs: claim.waitMs } });
  }

  try {
    return await sendClaimed(ctx, options, nowMs);
  } catch (error) {
    await releaseResend(ctx.redis, scene, phone, claim.token);
    throw error;
  }
}

async function sendClaimed(
  ctx: Ctx,
  options: SendCodeOptions,
  nowMs: number,
): Promise<SendCodeResult> {
  const { scene, phone } = options;
  const config = await ctx.config.get(smsConfig);
  await enforceSmsBudget(
    await fixedWindow(ctx.redis, {
      key: `sms:budget:hour:${phone}`,
      limit: config.perPhonePerHour,
      windowMs: HOUR_MS,
      nowMs,
    }),
  );
  await enforceSmsBudget(
    await fixedWindow(ctx.redis, {
      key: `sms:budget:day:${phone}`,
      limit: config.perPhonePerDay,
      windowMs: DAY_MS,
      nowMs,
    }),
  );
  if (options.ip) {
    await enforceSmsBudget(
      await fixedWindow(ctx.redis, {
        key: `sms:budget:ip:${options.ip}`,
        limit: options.perIpPerDay,
        windowMs: DAY_MS,
        nowMs,
      }),
    );
  }

  const code = generateCode();
  await issueCode(ctx.redis, { scene, phone, code, ttlMs: options.ttlMs });

  const sender = await resolveSender(ctx);
  let result: SmsSendResult;
  try {
    result = await sender.send({
      phone,
      templateId: config.templateVerifyCode,
      params: [{ name: 'code', value: code }],
    });
  } catch (error) {
    // `send` is documented not to throw, but a third-party object is a third
    // party: treat a thrown error exactly like a refusal.
    result = { ok: false, providerCode: 'THREW', error: String(error) };
  }

  if (!result.ok) {
    await discardCode(ctx.redis, scene, phone);
    ctx.logger.warn(
      { scene, provider: sender.name, providerCode: result.providerCode, error: result.error },
      '短信验证码发送失败',
    );
    throw new DomainError('AUTH_SMS_SEND_FAILED');
  }

  // The code itself is never logged. `logger.ts` redacts credential-shaped
  // keys, but the only reliable way not to leak a secret is not to pass it.
  ctx.logger.info(
    { scene, provider: sender.name, messageId: result.messageId },
    '短信验证码已发送',
  );

  return {
    expiresInSec: Math.round(options.ttlMs / 1000),
    resendAfterSec: Math.round(options.resendMs / 1000),
  };
}

function enforceSmsBudget(result: { allowed: boolean; retryAfterMs: number }): Promise<void> {
  if (!result.allowed) {
    throw new DomainError('AUTH_SMS_TOO_FREQUENT', {
      details: { retryAfterMs: result.retryAfterMs },
    });
  }
  return Promise.resolve();
}

/**
 * Consume a code, or refuse.
 *
 * Throws rather than returning a flag because every caller is a user-facing
 * transaction that must not proceed: there is no retry semantics to preserve.
 */
export async function verifyCode(
  ctx: Ctx,
  input: { scene: string; phone: string; code: string; maxAttempts: number },
): Promise<void> {
  const outcome: VerifyOutcome = await consumeCode(ctx.redis, input);
  if (outcome === 'ok') return;
  if (outcome === 'attempts-exceeded') throw new DomainError('AUTH_SMS_CODE_ATTEMPTS_EXCEEDED');
  throw new DomainError('AUTH_SMS_CODE_INVALID');
}
