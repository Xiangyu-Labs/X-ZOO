import { createHash } from 'node:crypto';
import { recordEffect } from '../effects';
import type { Ctx } from '../kernel/context';
import { wechatConfig } from './wechat.config';
import {
  decryptMessage,
  verifyMessageSignature,
  verifySignature,
  WechatMessageCryptoError,
} from './wechat.message-crypto';

/**
 * The mini program's 消息推送, `/api/v1/webhooks/wechat-mini`.
 *
 * WeChat POSTs the events a mini program subscribes to — here, 发货信息管理's
 * `trade_manage_*` (C07) and 内容安全's `wxa_media_check` (C09) — to one public
 * URL, configured in 公众平台 → 开发管理 → 消息推送 with **数据格式 JSON**.
 *
 * This file only decides whether a delivery is genuine and hands it on. It
 * follows the Official Account callback (`wechat-oa.webhook.service.ts`) step
 * for step, because the envelope is the same `WXBizMsgCrypt`:
 *
 * 0. **Which check.** The operator's 消息加解密方式 setting (`wechat.miniMessageMode`)
 *    decides, never the request: in 安全模式 a delivery without the encrypted
 *    envelope is refused rather than checked with the weaker plain signature.
 * 1. **Signature first**, over the query triple — plus the still-encrypted
 *    `Encrypt` in 安全/兼容模式 — before anything is decrypted, logged or
 *    written. The token and the AES key never reach a log line.
 * 2. **Fresh and single-use.** The triple is good for five minutes and for one
 *    body (the OA callback's rule 1a, for the same reason: it sits in every
 *    access log). In 明文/兼容模式 that one-body rule is the only thing tying
 *    the signature to the body, so when the nonce store (Redis) is down the
 *    delivery is refused with a 503 and WeChat retries it later (WXSHIP-008);
 *    in 安全模式 the signature covers the encrypted body itself and a
 *    delivery is still taken.
 * 3. **Decrypt**, with the appid inside the envelope checked against ours.
 * 4. **Record, don't act.** A known event becomes one effects-ledger row keyed
 *    by the SHA-256 of the decrypted message, in its own transaction, and the
 *    answer is `success`. `UNIQUE (scope, scope_id, event_type)` is the
 *    deduplication — WeChat re-delivers anything it did not see `success` for,
 *    and a re-delivery decrypts to the same message — and the ledger's retries
 *    are the durability: the handler that moves an order or hides an image
 *    runs after the answer, and again if it fails. Handlers are registered by
 *    the domain that owns the consequence (`payment` for `trade_manage_*`,
 *    `wechat.sec-check.ts` for `wxa_media_check`) under `MINI_PUSH_SCOPE`.
 *
 * An event nobody handles is answered `success` and dropped with a log line:
 * WeChat reads anything else as "retry", and retrying a message we will never
 * act on helps nobody.
 */

export const MINI_PUSH_SCOPE = 'wechat-mini-push';

/** The events this shop acts on. Anything else is acknowledged and dropped. */
export const MINI_PUSH_EVENTS = [
  'trade_manage_order_settlement',
  'trade_manage_remind_shipping',
  'trade_manage_remind_access_api',
  'wxa_media_check',
] as const;
export type MiniPushEvent = (typeof MINI_PUSH_EVENTS)[number];

/** A decrypted push: WeChat's JSON object, as WeChat spelled it. */
export type MiniPushMessage = Record<string, unknown>;

export interface MiniPushResult {
  status: number;
  body: string;
}

const OK: MiniPushResult = { status: 200, body: 'success' };
const FORBIDDEN: MiniPushResult = { status: 403, body: 'invalid signature' };
/** Anything but `success` makes WeChat deliver again later. */
const UNAVAILABLE: MiniPushResult = { status: 503, body: 'try again later' };

/** How far a push's `timestamp` may be from our clock, either way. */
export const MINI_PUSH_FRESHNESS_SECONDS = 300;
const NONCE_TTL_SECONDS = 2 * MINI_PUSH_FRESHNESS_SECONDS;
/** WeChat's pushes are a few hundred bytes; anything past this is not one. */
const MAX_BODY_BYTES = 64 * 1024;

async function credentials(ctx: Ctx) {
  const config = await ctx.config.get(wechatConfig);
  return {
    token: config.miniToken.trim(),
    aesKey: config.miniAesKey.trim(),
    appId: config.miniAppId.trim(),
    mode: config.miniMessageMode,
  };
}

// ---------------------------------------------------------------------------
// GET: the URL check 公众平台 runs when 消息推送 is saved
// ---------------------------------------------------------------------------

/** Echoes `echostr` only for a correctly signed, fresh request. */
export async function verifyMiniPushUrl(
  ctx: Ctx,
  query: Record<string, string | undefined>,
): Promise<MiniPushResult> {
  const { token } = await credentials(ctx);
  const timestamp = query['timestamp'] ?? '';
  const ok =
    verifySignature({
      token,
      signature: query['signature'] ?? '',
      timestamp,
      nonce: query['nonce'] ?? '',
    }) && isFresh(ctx, timestamp);
  if (!ok) {
    ctx.logger.warn({}, 'mini push: bad verification signature');
    return FORBIDDEN;
  }
  return { status: 200, body: query['echostr'] ?? '' };
}

// ---------------------------------------------------------------------------
// POST: a push
// ---------------------------------------------------------------------------

export interface MiniPushRequest {
  query: Record<string, string | undefined>;
  /** The raw body; only parsed once it is known to be bounded. */
  body: string;
}

export async function handleMiniPush(ctx: Ctx, req: MiniPushRequest): Promise<MiniPushResult> {
  if (Buffer.byteLength(req.body, 'utf8') > MAX_BODY_BYTES) return FORBIDDEN;
  const creds = await credentials(ctx);
  const timestamp = req.query['timestamp'] ?? '';
  const nonce = req.query['nonce'] ?? '';

  const envelope = parseObject(req.body);
  const encrypt = typeof envelope?.['Encrypt'] === 'string' ? envelope['Encrypt'] : '';

  // ---- 0: which check ------------------------------------------------------
  const saysEncrypted = (req.query['encrypt_type'] ?? '') === 'aes';
  const encrypted =
    creds.mode === 'safe'
      ? saysEncrypted
        ? true
        : null
      : creds.mode === 'compatible'
        ? saysEncrypted || encrypt !== ''
        : saysEncrypted;
  if (encrypted === null) {
    ctx.logger.warn({}, 'mini push: plaintext delivery refused in 安全模式');
    return FORBIDDEN;
  }

  // ---- 1-3: authenticate, spend the triple, decrypt ------------------------
  let plain: string;
  if (encrypted) {
    const ok = verifyMessageSignature({
      token: creds.token,
      msgSignature: req.query['msg_signature'] ?? '',
      timestamp,
      nonce,
      encrypt,
    });
    if (!ok) {
      ctx.logger.warn({}, 'mini push: bad message signature');
      return FORBIDDEN;
    }
    const refused = await admitTriple(ctx, creds.mode, { timestamp, nonce, body: req.body });
    if (refused) return refused;
    try {
      plain = decryptMessage({
        encodingAesKey: creds.aesKey,
        appId: creds.appId,
        encrypted: encrypt,
      });
    } catch (error) {
      const reason = error instanceof WechatMessageCryptoError ? error.reason : 'unknown';
      ctx.logger.warn({ reason }, 'mini push: decrypt failed');
      return FORBIDDEN;
    }
  } else {
    const ok = verifySignature({
      token: creds.token,
      signature: req.query['signature'] ?? '',
      timestamp,
      nonce,
    });
    if (!ok) {
      ctx.logger.warn({}, 'mini push: bad signature');
      return FORBIDDEN;
    }
    const refused = await admitTriple(ctx, creds.mode, { timestamp, nonce, body: req.body });
    if (refused) return refused;
    plain = req.body;
  }

  const message = parseObject(plain);
  if (!message) {
    // Signed by WeChat and still not JSON: 数据格式 is set to XML in 公众平台.
    ctx.logger.error({}, 'mini push: body is not JSON — set 数据格式 to JSON in 公众平台');
    return OK;
  }

  // ---- 4: record -----------------------------------------------------------
  const event = typeof message['Event'] === 'string' ? message['Event'] : '';
  if (!isKnownEvent(event)) {
    ctx.logger.info({ event, msgType: message['MsgType'] }, 'mini push: event not handled');
    return OK;
  }
  const scopeId = createHash('sha256').update(plain, 'utf8').digest('hex');
  const created = await ctx.withTx((tx) =>
    recordEffect(tx, ctx, { scope: MINI_PUSH_SCOPE, scopeId, eventType: event, payload: message }),
  );
  ctx.logger.info({ event, replay: !created }, 'mini push recorded');
  return OK;
}

function isKnownEvent(event: string): event is MiniPushEvent {
  return (MINI_PUSH_EVENTS as readonly string[]).includes(event);
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// freshness and single use (the OA callback's rule, for the same reason)
// ---------------------------------------------------------------------------

function isFresh(ctx: Ctx, timestamp: string): boolean {
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const skew = Math.abs(Math.floor(ctx.clock.now().getTime() / 1000) - Number(timestamp));
  if (skew > MINI_PUSH_FRESHNESS_SECONDS) {
    ctx.logger.warn({ skew }, 'mini push: stale timestamp');
    return false;
  }
  return true;
}

/**
 * `spent` for the first body seen under `(timestamp, nonce)` and for a
 * byte-identical re-delivery of it; `refused` for a stale triple or another
 * body; `store-down` when Redis could not answer.
 */
async function spendTriple(
  ctx: Ctx,
  args: { timestamp: string; nonce: string; body: string },
): Promise<'spent' | 'refused' | 'store-down'> {
  if (!isFresh(ctx, args.timestamp)) return 'refused';
  const key = `wechat-mini:nonce:${args.nonce}:${args.timestamp}`;
  const digest = createHash('sha256').update(args.body).digest('hex');
  try {
    if ((await ctx.redis.set(key, digest, 'EX', NONCE_TTL_SECONDS, 'NX')) === 'OK') return 'spent';
    if ((await ctx.redis.get(key)) === digest) return 'spent';
    ctx.logger.warn({}, 'mini push: a spent signature triple was reused for another body');
    return 'refused';
  } catch (error) {
    ctx.logger.warn({ err: error }, 'mini push nonce store unavailable');
    return 'store-down';
  }
}

/**
 * `null` when the delivery may go on; otherwise the answer to give.
 *
 * With the nonce store down (WXSHIP-008): in 安全模式 the delivery is taken —
 * `msg_signature` covers the encrypted body, so a leaked URL cannot carry
 * another message, the freshness window still holds and the ledger's unique
 * key still deduplicates. In 明文/兼容模式 the signature covers only
 * `(token, timestamp, nonce)`: a signed URL from an access log could carry any
 * body for five minutes — a forged `trade_manage_order_settlement` would mark
 * an order received — so the delivery is refused with a 503 and WeChat, which
 * re-delivers anything not answered `success`, tries again once Redis is back.
 */
async function admitTriple(
  ctx: Ctx,
  mode: 'plain' | 'compatible' | 'safe',
  args: { timestamp: string; nonce: string; body: string },
): Promise<MiniPushResult | null> {
  const outcome = await spendTriple(ctx, args);
  if (outcome === 'spent') return null;
  if (outcome === 'refused') return FORBIDDEN;
  if (mode === 'safe') return null;
  ctx.logger.warn({ mode }, 'mini push refused: no nonce store to bind the signature to the body');
  return UNAVAILABLE;
}
