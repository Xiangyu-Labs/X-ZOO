import { createHash } from 'node:crypto';
import type { WechatReplyPayload, WechatReplyType } from '@shop/contracts/wechat-oa/schemas';
import type { Ctx } from '../kernel/context';
import { wechatOaRuntimeConfig } from './wechat-oa.config';
import { oaCredentials } from './wechat-oa.credentials';
import {
  buildXml,
  cdata,
  decryptMessage,
  encryptReply,
  parseXml,
  verifyMessageSignature,
  verifySignature,
  WechatOaCryptoError,
} from './wechat-oa.crypto';
import * as repo from './wechat-oa.repo';

/**
 * The Official Account message callback.
 *
 * WeChat POSTs every follow, unfollow, scan, menu tap and customer message to
 * one public URL and gives us **five seconds** to answer. A late or non-`success`
 * answer is retried three times and then shown to the customer as
 * 该公众号暂时无法提供服务. Everything below follows from those two facts.
 *
 * ## The order, which is the whole security model
 *
 * 0. **Is it on, and is this the mode we run in.** A disabled account answers
 *    nothing. An account configured in 安全模式 refuses a plaintext delivery:
 *    which path is taken is the *setting's* choice, never the request's
 *    `encrypt_type` — otherwise dropping `encrypt_type` from a logged query
 *    string would downgrade the check to one that does not cover the body.
 * 1. **Signature.** `verifySignature` over the three query parameters, or
 *    `verifyMessageSignature` over those plus the still-encrypted payload. This
 *    happens before the body is parsed, before Redis is touched and before
 *    anything is written. The URL is public and unauthenticated in every other
 *    respect: an unsigned "this user just subscribed" would otherwise hand out
 *    the new-follower coupon to anybody who can spell the openid.
 * 1a. **Freshness and single use.** In 明文 mode the signature covers
 *    `token`, `timestamp` and `nonce` — not the body — and WeChat puts that
 *    triple on the query string of every callback, so every access-log line
 *    holds one. A triple is therefore good for five minutes either side of our
 *    clock, and for **one body**: the first delivery binds `(timestamp, nonce)`
 *    to the body's hash, WeChat's own retries of that body pass (the dedupe in
 *    step 3 then answers them), and anything else under the same triple is 403.
 * 2. **Decrypt** (safe and compatible modes), with the appid inside the
 *    envelope checked against ours.
 * 3. **Deduplicate.** WeChat re-delivers on its own timeout, so the same event
 *    arrives up to four times. The key is `MsgId` when there is one and
 *    `FromUserName:CreateTime:Event` when there is not, held for 15 minutes —
 *    comfortably longer than WeChat's retry schedule.
 * 4. **Answer, inside the budget.** The work races a timer; if the work loses,
 *    the callback still answers `success` and the side effects finish in the
 *    background. A customer waiting on a keyword reply would rather see nothing
 *    than see 该公众号暂时无法提供服务 — and WeChat's retry would run the same
 *    work again.
 */

export interface OaWebhookResult {
  status: number;
  /** Always `text/plain`. Never JSON: WeChat reads anything but `success` as a failure. */
  body: string;
}

const OK: OaWebhookResult = { status: 200, body: 'success' };
const FORBIDDEN: OaWebhookResult = { status: 403, body: 'invalid signature' };

/** WeChat's own window is 5 s; leaving 1 s for the network is the difference between late and on time. */
const BUDGET_MS = 4_000;
/** Longer than WeChat's retry schedule (4 deliveries inside ~15 s) with room to spare. */
const DEDUPE_TTL_SECONDS = 900;
/** How far a callback's `timestamp` may be from our clock, either way. */
export const FRESHNESS_SECONDS = 300;
/** Outlives the freshness window on both sides, so a spent triple cannot come back. */
const NONCE_TTL_SECONDS = 2 * FRESHNESS_SECONDS;

// ---------------------------------------------------------------------------
// GET: the URL verification handshake
// ---------------------------------------------------------------------------

/**
 * Answers 公众平台's 提交 button by echoing `echostr` — and only if the
 * signature checks out.
 *
 * Echoing unconditionally, which is what most tutorials show, turns the
 * endpoint into an open reflector and, more to the point, means the operator's
 * token was never actually verified: the URL "works" with the wrong token and
 * then no message ever arrives.
 */
export async function verifyUrl(
  ctx: Ctx,
  query: Record<string, string | undefined>,
): Promise<OaWebhookResult> {
  const { token } = await oaCredentials(ctx);
  const timestamp = query['timestamp'] ?? '';
  const ok =
    verifySignature({
      token,
      signature: query['signature'] ?? '',
      timestamp,
      nonce: query['nonce'] ?? '',
    }) && isFresh(ctx, timestamp);
  if (!ok) {
    ctx.logger.warn(
      { path: '/api/v1/webhooks/wechat-oa' },
      'oa webhook: bad verification signature',
    );
    return FORBIDDEN;
  }
  return { status: 200, body: query['echostr'] ?? '' };
}

// ---------------------------------------------------------------------------
// POST: an event
// ---------------------------------------------------------------------------

export interface OaWebhookRequest {
  query: Record<string, string | undefined>;
  /** The raw request body. Parsed only after the signature has been checked. */
  body: string;
}

export async function handleEvent(ctx: Ctx, req: OaWebhookRequest): Promise<OaWebhookResult> {
  const credentials = await oaCredentials(ctx);
  if (!credentials.enabled) {
    ctx.logger.warn({}, 'oa webhook: callback for a disabled account');
    return FORBIDDEN;
  }
  const timestamp = req.query['timestamp'] ?? '';
  const nonce = req.query['nonce'] ?? '';

  // ---- 0: which path — the setting's choice, not the request's -------------
  const encrypted = chooseEncrypted(credentials.messageMode, req);
  if (encrypted === null) {
    ctx.logger.warn({}, 'oa webhook: plaintext callback refused in 安全模式');
    return FORBIDDEN;
  }

  // ---- 1 & 2: authenticate, then decrypt -----------------------------------
  let plain: string;
  if (encrypted) {
    // The ciphertext has to be read out of the envelope to be signed over, so
    // this one parse happens before the check. It reads a single element out of
    // a bounded string and has no side effect of any kind.
    const envelope = parseXml(req.body);
    const encrypt = envelope['Encrypt'] ?? '';
    const ok = verifyMessageSignature({
      token: credentials.token,
      msgSignature: req.query['msg_signature'] ?? '',
      timestamp,
      nonce,
      encrypt,
    });
    if (!ok) {
      ctx.logger.warn({}, 'oa webhook: bad message signature');
      return FORBIDDEN;
    }
    if (!(await spendTriple(ctx, { timestamp, nonce, body: req.body }))) return FORBIDDEN;
    try {
      plain = decryptMessage({
        encodingAesKey: credentials.encodingAesKey,
        appId: credentials.appId,
        encrypted: encrypt,
      });
    } catch (error) {
      const reason = error instanceof WechatOaCryptoError ? error.reason : 'unknown';
      ctx.logger.warn({ reason }, 'oa webhook: decrypt failed');
      return FORBIDDEN;
    }
  } else {
    const ok = verifySignature({
      token: credentials.token,
      signature: req.query['signature'] ?? '',
      timestamp,
      nonce,
    });
    if (!ok) {
      ctx.logger.warn({}, 'oa webhook: bad signature');
      return FORBIDDEN;
    }
    if (!(await spendTriple(ctx, { timestamp, nonce, body: req.body }))) return FORBIDDEN;
    plain = req.body;
  }

  const message = parseXml(plain);
  const fromUser = message['FromUserName'] ?? '';
  const toUser = message['ToUserName'] ?? '';
  if (fromUser === '') return OK;

  // ---- 3: deduplicate ------------------------------------------------------
  const key = dedupeKey(message);
  const first = await claim(ctx, key);
  if (!first) {
    // A replay answers with whatever the first delivery answered, so a customer
    // whose keyword reply was lost to a WeChat timeout still gets it.
    const cached = await recallReply(ctx, key);
    return { status: 200, body: cached ?? 'success' };
  }

  // ---- 4: work, inside the budget -----------------------------------------
  const work = (async () => {
    const reply = await respond(ctx, message);
    if (reply === null) return 'success';
    return sealReply(credentials, { reply, toUser, fromUser, timestamp, nonce, encrypted, ctx });
  })();

  const body = await withBudget(ctx, work);
  if (body !== 'success') await rememberReply(ctx, key, body);
  return { status: 200, body };
}

/**
 * Returns `success` when the work outruns the budget — and lets the work carry
 * on.
 *
 * Cancelling it would be worse: the follow has already happened and the row
 * that records it is the shop's only trace. The unhandled-rejection guard is
 * there because a promise nobody awaits still crashes the process in Node.
 */
async function withBudget(ctx: Ctx, work: Promise<string>): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve('success'), BUDGET_MS);
  });
  work.catch((error: unknown) => {
    ctx.logger.error({ err: error }, 'oa webhook handler failed');
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// mode, freshness, single use
// ---------------------------------------------------------------------------

/**
 * `true` for the encrypted path, `false` for the plain one, `null` to refuse.
 *
 * - 安全模式: encrypted or nothing. The operator chose it so that the body is
 *   authenticated; a request that simply omits `encrypt_type` does not get to
 *   choose the check that does not cover the body.
 * - 兼容模式: WeChat sends both forms in one body. The envelope is preferred
 *   whenever it is there, so a delivery that carries one is always held to
 *   `msg_signature`.
 * - 明文模式: plain, unless the request says it is encrypted (an operator who
 *   switched 公众平台 first and our screen second still gets their messages).
 */
function chooseEncrypted(
  mode: 'plain' | 'compatible' | 'safe',
  req: OaWebhookRequest,
): boolean | null {
  const saysEncrypted = (req.query['encrypt_type'] ?? '') === 'aes';
  if (mode === 'safe') return saysEncrypted ? true : null;
  if (mode === 'compatible') return saysEncrypted || /<Encrypt>/.test(req.body);
  return saysEncrypted;
}

/** `timestamp` is a decimal epoch-seconds value within `FRESHNESS_SECONDS` of `ctx.clock`. */
function isFresh(ctx: Ctx, timestamp: string): boolean {
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const skew = Math.abs(Math.floor(ctx.clock.now().getTime() / 1000) - Number(timestamp));
  if (skew > FRESHNESS_SECONDS) {
    ctx.logger.warn({ skew }, 'oa webhook: stale timestamp');
    return false;
  }
  return true;
}

/**
 * Spends `(timestamp, nonce)` on this body: `true` for the first body seen
 * under the triple and for a byte-identical re-delivery of it, `false` for a
 * stale triple or a different body.
 *
 * Binding the body rather than refusing every second use is what keeps
 * WeChat's own retries working whether or not they re-sign: a retry that
 * carries the original triple is the same body, passes here, and is answered
 * from the dedupe cache in step 3 — which is where re-deliveries have always
 * been handled.
 *
 * Redis down: the triple is let through, as the dedupe claim is. The freshness
 * window still holds, so what is lost for the length of an outage is the
 * single use inside five minutes, not the protection against last month's log.
 */
async function spendTriple(
  ctx: Ctx,
  args: { timestamp: string; nonce: string; body: string },
): Promise<boolean> {
  if (!isFresh(ctx, args.timestamp)) return false;
  const key = `wechat-oa:nonce:${args.nonce}:${args.timestamp}`;
  const digest = createHash('sha256').update(args.body).digest('hex');
  try {
    if ((await ctx.redis.set(key, digest, 'EX', NONCE_TTL_SECONDS, 'NX')) === 'OK') return true;
    if ((await ctx.redis.get(key)) === digest) return true;
    ctx.logger.warn({}, 'oa webhook: a spent signature triple was reused for another body');
    return false;
  } catch (error) {
    ctx.logger.warn({ err: error }, 'oa webhook nonce store unavailable');
    return true;
  }
}

// ---------------------------------------------------------------------------
// deduplication
// ---------------------------------------------------------------------------

/**
 * `MsgId` for a message, `FromUserName:CreateTime:Event` for an event.
 *
 * Events carry no `MsgId` at all, which is why the second form exists; the
 * event name is in the key because a follow and the scan that caused it arrive
 * as two callbacks one second apart and are genuinely two events.
 */
export function dedupeKey(message: Record<string, string>): string {
  const msgId = message['MsgId'] ?? '';
  if (msgId !== '') return `wechat-oa:msg:${msgId}`;
  const from = message['FromUserName'] ?? '';
  const at = message['CreateTime'] ?? '';
  const event = message['Event'] ?? message['MsgType'] ?? '';
  return `wechat-oa:evt:${from}:${at}:${event}`;
}

async function claim(ctx: Ctx, key: string): Promise<boolean> {
  try {
    return (await ctx.redis.set(key, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX')) === 'OK';
  } catch (error) {
    // Redis down: process it. A duplicated follow is a second row in
    // `wechat_qrcode_scans`; a dropped follow is a customer who never got the
    // greeting and no record that they arrived.
    ctx.logger.warn({ err: error }, 'oa webhook dedupe unavailable');
    return true;
  }
}

async function rememberReply(ctx: Ctx, key: string, body: string): Promise<void> {
  try {
    await ctx.redis.set(`${key}:reply`, body, 'EX', DEDUPE_TTL_SECONDS);
  } catch {
    // The replay then answers `success`, which is a lost auto-reply, not a lost event.
  }
}

async function recallReply(ctx: Ctx, key: string): Promise<string | null> {
  try {
    return await ctx.redis.get(`${key}:reply`);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// what each kind of callback does
// ---------------------------------------------------------------------------

interface Reply {
  replyType: WechatReplyType;
  payload: WechatReplyPayload;
}

async function respond(ctx: Ctx, message: Record<string, string>): Promise<Reply | null> {
  const type = message['MsgType'] ?? '';
  if (type === 'event') return onEvent(ctx, message);
  if (type === 'text') return matchKeyword(ctx, (message['Content'] ?? '').trim());
  // Images, voice, location and the rest fall through to the default reply,
  // which is the one thing a customer sending a photo to a shop expects.
  return fallbackReply(ctx);
}

async function onEvent(ctx: Ctx, message: Record<string, string>): Promise<Reply | null> {
  const event = (message['Event'] ?? '').toLowerCase();
  const openid = message['FromUserName'] ?? '';
  const eventKey = message['EventKey'] ?? '';
  const now = ctx.clock.now();

  switch (event) {
    case 'subscribe': {
      await repo.setSubscribed(ctx.db, { openid, subscribed: true, now });
      // A follow that came from a channel poster carries `qrscene_<scene>`.
      const scene = eventKey.startsWith('qrscene_') ? eventKey.slice('qrscene_'.length) : '';
      const scanned = scene === '' ? null : await recordScan(ctx, { scene, openid, isNew: true });
      return scanned ?? (await subscribeReply(ctx));
    }
    case 'unsubscribe':
      await repo.setSubscribed(ctx.db, { openid, subscribed: false, now });
      // WeChat ignores any reply to an unsubscribe: the conversation is over.
      return null;
    case 'scan': {
      const scanned = await recordScan(ctx, { scene: eventKey, openid, isNew: false });
      return scanned ?? (await fallbackReply(ctx));
    }
    case 'click':
      // A menu button's key is matched against the keyword rules, so an
      // operator configures 联系客服 once instead of twice.
      return matchKeyword(ctx, eventKey);
    default:
      return null;
  }
}

/**
 * Records one scan and returns the channel code's own reply, if it has one.
 *
 * Returns `null` when the scene belongs to no QR code of ours — which happens,
 * because a scene string can be left over from a poster printed before a code
 * was deleted, and inventing a row for it would corrupt the channel report.
 */
async function recordScan(
  ctx: Ctx,
  args: { scene: string; openid: string; isNew: boolean },
): Promise<Reply | null> {
  const qrcode = await repo.findQrcodeByScene(ctx.db, args.scene);
  if (!qrcode) return null;

  const fresh = await notRecentlyScanned(ctx, qrcode.id, args.openid);
  if (fresh) {
    const identity = await repo.findIdentityByOpenid(ctx.db, args.openid);
    const now = ctx.clock.now();
    await ctx.withTx(async (tx) => {
      await repo.insertScan(tx, {
        qrcodeId: qrcode.id,
        ...(identity ? { userId: identity.userId } : {}),
        openid: args.openid,
        isNewFollower: args.isNew,
        // The injected clock, not the column's `now()` default: the daily
        // channel report buckets on this column, and a row timed by the database
        // while the counter next to it is timed by `ctx.clock` makes the two
        // disagree — visibly so under a fake clock, invisibly so when the
        // database and the app are in different timezones.
        createdAt: now,
      });
      await repo.bumpQrcodeCounters(tx, qrcode.id, { scan: true, follow: args.isNew, now });
    });
  }

  if (qrcode.status !== 'active' || qrcode.replyType === null) return null;
  return {
    replyType: qrcode.replyType,
    payload: (qrcode.replyPayload ?? {}) as WechatReplyPayload,
  };
}

/**
 * The scan-counting window.
 *
 * A poster gets photographed and re-scanned by the same phone all afternoon,
 * and WeChat re-delivers on every retry. Without this the counter measures
 * patience rather than reach. Configurable, and `0` turns it off for a shop
 * that wants the raw number.
 */
async function notRecentlyScanned(ctx: Ctx, qrcodeId: number, openid: string): Promise<boolean> {
  const { scanDedupeSeconds } = await ctx.config.get(wechatOaRuntimeConfig);
  if (scanDedupeSeconds <= 0 || openid === '') return true;
  try {
    const won = await ctx.redis.set(
      `wechat-oa:scan:${qrcodeId}:${openid}`,
      '1',
      'EX',
      scanDedupeSeconds,
      'NX',
    );
    return won === 'OK';
  } catch {
    return true;
  }
}

async function matchKeyword(ctx: Ctx, text: string): Promise<Reply | null> {
  if (text === '') return fallbackReply(ctx);
  const rows = await repo.findKeywordReplies(ctx.db, text);
  const best = rows[0];
  if (!best) return fallbackReply(ctx);
  return { replyType: best.replyType, payload: best.payload as WechatReplyPayload };
}

async function subscribeReply(ctx: Ctx): Promise<Reply | null> {
  const row = await repo.findSingletonReply(ctx.db, 'subscribe');
  return row ? { replyType: row.replyType, payload: row.payload as WechatReplyPayload } : null;
}

async function fallbackReply(ctx: Ctx): Promise<Reply | null> {
  const row = await repo.findSingletonReply(ctx.db, 'default');
  return row ? { replyType: row.replyType, payload: row.payload as WechatReplyPayload } : null;
}

// ---------------------------------------------------------------------------
// building the answer
// ---------------------------------------------------------------------------

/** The passive reply XML for one configured reply. `ToUser` and `FromUser` swap. */
export function buildReplyXml(args: {
  reply: Reply;
  toUser: string;
  fromUser: string;
  createTime: number;
}): string {
  const head = {
    ToUserName: args.fromUser,
    FromUserName: args.toUser,
    CreateTime: args.createTime,
  };
  const { replyType, payload } = args.reply;

  const mediaId = `<MediaId>${cdata(payload.mediaId ?? '')}</MediaId>`;

  switch (replyType) {
    case 'text':
      return buildXml({ ...head, MsgType: 'text', Content: payload.text ?? '' });
    case 'image':
      return buildXml({ ...head, MsgType: 'image' }, `<Image>${mediaId}</Image>`);
    case 'voice':
      return buildXml({ ...head, MsgType: 'voice' }, `<Voice>${mediaId}</Voice>`);
    case 'video':
      return buildXml(
        { ...head, MsgType: 'video' },
        `<Video>${mediaId}<Title>${cdata(payload.title ?? '')}</Title><Description>${cdata(payload.description ?? '')}</Description></Video>`,
      );
    case 'news': {
      // WeChat renders at most 8 and silently drops the message if there are 0.
      const articles = (payload.articles ?? []).slice(0, 8);
      if (articles.length === 0) return 'success';
      const items = articles
        .map(
          (article) =>
            `<item><Title>${cdata(article.title)}</Title><Description>${cdata(article.description)}</Description><PicUrl>${cdata(article.picUrl)}</PicUrl><Url>${cdata(article.url)}</Url></item>`,
        )
        .join('');
      return buildXml(
        { ...head, MsgType: 'news' },
        `<ArticleCount>${articles.length}</ArticleCount><Articles>${items}</Articles>`,
      );
    }
  }
}

/**
 * Encrypts the reply exactly when the request was encrypted.
 *
 * Mirroring the request rather than reading 消息加解密方式 is what makes 兼容模式
 * work: WeChat sends both forms there and accepts whichever we answer with, and
 * a setting somebody changed in 公众平台 but not in our admin cannot break the
 * conversation.
 */
function sealReply(
  credentials: { token: string; encodingAesKey: string; appId: string },
  args: {
    reply: Reply;
    toUser: string;
    fromUser: string;
    timestamp: string;
    nonce: string;
    encrypted: boolean;
    ctx: Ctx;
  },
): string {
  const xml = buildReplyXml({
    reply: args.reply,
    toUser: args.toUser,
    fromUser: args.fromUser,
    createTime: Math.floor(args.ctx.clock.now().getTime() / 1000),
  });
  if (xml === 'success') return 'success';
  if (!args.encrypted) return xml;

  try {
    return encryptReply({
      token: credentials.token,
      encodingAesKey: credentials.encodingAesKey,
      appId: credentials.appId,
      message: xml,
      timestamp: args.timestamp,
      nonce: args.nonce,
    });
  } catch (error) {
    // Answering in plaintext to an account in 安全模式 is rejected by WeChat and
    // shown to the customer; `success` is silent, which is the better failure.
    args.ctx.logger.error({ err: error }, 'oa webhook: could not encrypt reply');
    return 'success';
  }
}
