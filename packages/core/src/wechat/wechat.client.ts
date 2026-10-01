import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { randomToken } from '../kernel/ids';
import { wechatConfig, type WechatConfig } from './wechat.config';
import { wechatRefusal } from './wechat.errcodes';

/**
 * The first-party WeChat client: identity, the app access token, and messages.
 *
 * No SDK, `fetch` and `node:crypto` only. Two things here are load-bearing for
 * other domains and are therefore spelled out rather than left to a library:
 *
 *  1. **The access token is single-flighted.** WeChat invalidates the previous
 *     token every time you ask for a new one, so two concurrent refreshes do
 *     not merely waste a call — the second one *breaks* the first. The guard is
 *     two-layered: one promise per process, and `SET … NX PX` across processes.
 *  2. **A WeChat business error is a return value, not an exception.** These
 *     calls run behind the effects ledger, where a thrown error costs a retry
 *     and tells nobody why. A *transport* failure still throws, because that is
 *     the case a retry actually fixes.
 *
 * What it throws says what failed in Chinese, with WeChat's errcode as
 * （错误码 N）. WeChat's errmsg and the request path go to the log only
 * (AGENTS rule 1): they would otherwise reach a toast and the effects ledger.
 */

export type WechatApp = 'oa' | 'mini';

export interface WechatSendResult {
  ok: boolean;
  /** WeChat's own `errcode`; `0` on success. */
  errcode: number;
  errmsg: string;
  msgid?: string;
}

export interface OaCodeExchange {
  openid: string;
  unionid?: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

export interface WechatProfile {
  openid: string;
  unionid?: string;
  nickname?: string;
  avatarUrl?: string;
}

export interface MiniSession {
  openid: string;
  unionid?: string;
  sessionKey: string;
}

export interface TemplateMessageInput {
  touser: string;
  templateId: string;
  url?: string;
  miniprogram?: { appid: string; pagepath: string };
  data: Record<string, { value: string; color?: string }>;
}

export interface SubscribeMessageInput {
  touser: string;
  templateId: string;
  page?: string;
  miniprogramState?: 'developer' | 'trial' | 'formal';
  data: Record<string, { value: string }>;
}

export interface WechatCall {
  method: 'GET' | 'POST';
  /** Path only, e.g. `/cgi-bin/message/template/send`. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

/**
 * What a binary endpoint answered.
 *
 * A handful of WeChat endpoints — `wxa/getwxacodeunlimit`, `qrcode/showqrcode`,
 * `media/get` — answer **200 with the file** on success and **200 with a JSON
 * `errcode` body** on failure. The status line says nothing either way, so the
 * caller has to look at what came back; a client that assumed JSON would store
 * a 43-byte error message as a PNG and the shop would serve broken images with
 * nothing in the log.
 */
export type WechatBytesResult =
  { ok: true; bytes: Buffer; contentType: string } | { ok: false; errcode: number; errmsg: string };

/**
 * A multipart upload: WeChat's material endpoints (`media/upload`,
 * `material/add_material`) take the file as one form field.
 */
export interface WechatUpload {
  /** Path only, e.g. `/cgi-bin/material/add_material`. */
  path: string;
  query?: Record<string, string>;
  /** The form field WeChat reads the file from — `media` for every material endpoint. */
  field: string;
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

export interface WechatCoreClient {
  oaCodeExchange(code: string): Promise<OaCodeExchange>;
  oaUserInfo(args: { accessToken: string; openid: string }): Promise<WechatProfile>;
  miniCode2Session(code: string): Promise<MiniSession>;
  accessToken(app: WechatApp): Promise<string>;
  invalidateAccessToken(app: WechatApp): Promise<void>;
  sendTemplateMessage(input: TemplateMessageInput): Promise<WechatSendResult>;
  sendSubscribeMessage(input: SubscribeMessageInput): Promise<WechatSendResult>;
  call<T>(app: WechatApp, req: WechatCall): Promise<T>;
  /** For the endpoints that answer a file on success and JSON on failure. */
  callBytes(app: WechatApp, req: WechatCall): Promise<WechatBytesResult>;
  /**
   * A multipart upload with the same token handling as `call`: the cached
   * token, the single flight, and `40001 → drop it and retry once`. Answers
   * WeChat's JSON exactly as `call` does — an `errcode` is a return value, a
   * transport failure throws.
   */
  upload<T>(app: WechatApp, req: WechatUpload): Promise<T>;
}

// ---------------------------------------------------------------------------
// wire shapes
// ---------------------------------------------------------------------------

interface WechatEnvelope {
  errcode?: number;
  errmsg?: string;
}

/** WeChat answers 200 with an `errcode` body; the HTTP status says nothing. */
function envelopeOf(value: unknown): WechatEnvelope {
  return (value ?? {}) as WechatEnvelope;
}

/** `40001`/`42001` mean the token we used is dead: drop it and try once more. */
const TOKEN_ERRCODES = new Set([40001, 40014, 42001]);

/** The token is refreshed this long before WeChat says it expires. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * How long one call to `api.weixin.qq.com` may take, body included.
 *
 * These calls run on the effects dispatcher, one at a time, under a 60-second
 * lease: a request that never answers would stall every effect behind it and
 * then run twice when the lease lapsed. A timeout fails like any transport
 * failure — thrown, and retried by the ledger.
 */
export const WECHAT_API_TIMEOUT_MS = 10_000;
/** How long one process may hold the cross-process refresh lock. */
const LOCK_TTL_MS = 10_000;
/** How long a loser waits for the winner's token before refreshing anyway. */
const LOCK_WAIT_STEPS = 10;
const LOCK_WAIT_MS = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * In-process single flight, keyed by cache key. Module-level on purpose: two
 * `Ctx` objects in one process are still one process as far as WeChat's
 * "issuing a token invalidates the last one" rule is concerned.
 */
const inflight = new Map<string, Promise<string>>();

/** Test helper. Never call this from app code. */
export function resetWechatTokenFlight(): void {
  inflight.clear();
}

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

export function createWechatClient(ctx: Ctx): WechatCoreClient {
  const load = () => ctx.config.get(wechatConfig);

  function credentials(config: WechatConfig, app: WechatApp): { appId: string; secret: string } {
    const appId = app === 'oa' ? config.oaAppId : config.miniAppId;
    const secret = app === 'oa' ? config.oaAppSecret : config.miniAppSecret;
    // Something staff can act on, so a registered code, whose Chinese message
    // `handle()` shows, rather than `INTERNAL`. The callers check first; this
    // is the backstop.
    if (!appId || !secret) {
      throw new DomainError(
        app === 'oa' ? 'WECHAT_OA_NOT_CONFIGURED' : 'AUTH_WECHAT_NOT_CONFIGURED',
      );
    }
    return { appId, secret };
  }

  const cacheKey = (appId: string) => `wechat:access-token:${appId}`;

  /**
   * One request to `api.weixin.qq.com`.
   *
   * Never logs the body of a credential exchange and never logs a token: the
   * log object is built from the path and the errcode only. TLS verification is
   * whatever Node's default trust store says, and there is no way to turn it
   * off from anywhere in this system (TLS-001).
   */
  async function request(baseUrl: string, req: WechatCall, form?: FormData): Promise<unknown> {
    const url = new URL(req.path, baseUrl);
    for (const [key, value] of Object.entries(req.query ?? {})) url.searchParams.set(key, value);

    const response = await fetch(url, {
      method: req.method,
      signal: AbortSignal.timeout(WECHAT_API_TIMEOUT_MS),
      // A form sets its own `multipart/form-data; boundary=…` content type.
      headers: {
        accept: 'application/json',
        ...(form !== undefined || req.body === undefined
          ? {}
          : { 'content-type': 'application/json; charset=utf-8' }),
      },
      ...(form !== undefined
        ? { body: form }
        : req.body === undefined
          ? {}
          : { body: JSON.stringify(req.body) }),
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      throw unreadable(req.path, response.status);
    }
    if (!response.ok) throw unavailable(req.path, response.status);
    return parsed;
  }

  /**
   * The same request, kept as bytes.
   *
   * Separate from `request` rather than a flag on it, because the two differ in
   * what they do with the response and agree on nothing else: this one decides
   * from the `content-type` whether it is holding a file or a refusal, and a
   * refusal is a return value here exactly as it is everywhere else in this
   * client.
   */
  async function requestBytes(baseUrl: string, req: WechatCall): Promise<WechatBytesResult> {
    const url = new URL(req.path, baseUrl);
    for (const [key, value] of Object.entries(req.query ?? {})) url.searchParams.set(key, value);

    const response = await fetch(url, {
      method: req.method,
      signal: AbortSignal.timeout(WECHAT_API_TIMEOUT_MS),
      headers: {
        accept: '*/*',
        ...(req.body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      },
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
    });

    if (!response.ok) throw unavailable(req.path, response.status);

    const contentType = response.headers.get('content-type') ?? '';
    const bytes = Buffer.from(await response.arrayBuffer());
    // JSON here means WeChat refused. Anything else is the file.
    if (!/^(application\/json|text\/plain)/i.test(contentType)) {
      return { ok: true, bytes, contentType: contentType || 'application/octet-stream' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw unreadable(req.path, response.status);
    }
    const envelope = envelopeOf(parsed);
    return {
      ok: false,
      errcode: envelope.errcode ?? -1,
      errmsg: envelope.errmsg ?? '',
    };
  }

  /** A transport failure: thrown, so the ledger retries it. The path is for the log. */
  function unavailable(path: string, status: number): DomainError {
    ctx.logger.warn({ path, status }, 'wechat api answered a non-2xx status');
    return new DomainError('INTERNAL', { message: `微信接口暂时不可用（HTTP ${status}）` });
  }

  function unreadable(path: string, status: number): DomainError {
    ctx.logger.warn({ path, status }, 'wechat api answered something that is not JSON');
    return new DomainError('INTERNAL', { message: '微信接口返回的内容无法识别' });
  }

  /**
   * WeChat refused a credential exchange. The adapter over this client maps a
   * spent or invalid code onto a refusal the shopper can act on, so `details`
   * keeps the errcode; the errmsg is logged and goes nowhere else.
   */
  function refused(what: string, path: string, body: WechatEnvelope): DomainError {
    ctx.logger.warn({ path, errcode: body.errcode, errmsg: body.errmsg }, 'wechat refused');
    return new DomainError('INTERNAL', {
      message: wechatRefusal(what, body.errcode),
      details: { errcode: body.errcode ?? null },
    });
  }

  /** Fetches a fresh token and caches it. Only ever called behind both locks. */
  async function refresh(config: WechatConfig, app: WechatApp): Promise<string> {
    const { appId, secret } = credentials(config, app);
    const body = envelopeOf(
      await request(config.apiBaseUrl, {
        method: 'GET',
        path: '/cgi-bin/token',
        query: { grant_type: 'client_credential', appid: appId, secret },
      }),
    ) as WechatEnvelope & { access_token?: string; expires_in?: number };

    if (!body.access_token) throw refused('获取微信接口凭证失败', '/cgi-bin/token', body);
    const ttlMs = Math.max(60_000, (body.expires_in ?? 7200) * 1000 - REFRESH_MARGIN_MS);
    await ctx.redis.set(cacheKey(appId), body.access_token, 'PX', ttlMs);
    return body.access_token;
  }

  /**
   * Cache read, then the cross-process lock, then the fetch.
   *
   * A caller that loses the lock waits up to a second for the winner's token
   * and then refreshes anyway. Refreshing anyway is deliberate: a held lock
   * whose owner crashed would otherwise stall every request in the shop for the
   * lock's whole TTL, and a redundant refresh costs one extra call, not
   * correctness — the loser's own `SET` makes its token the cached one.
   */
  async function acquire(app: WechatApp): Promise<string> {
    const config = await load();
    const { appId } = credentials(config, app);
    const key = cacheKey(appId);

    const cached = await ctx.redis.get(key);
    if (cached) return cached;

    const existing = inflight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      const lockKey = `${key}:lock`;
      const token = randomToken(16);
      const won = await ctx.redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX');

      if (!won) {
        for (let step = 0; step < LOCK_WAIT_STEPS; step += 1) {
          await sleep(LOCK_WAIT_MS);
          const value = await ctx.redis.get(key);
          if (value) return value;
        }
        ctx.logger.warn({ app }, 'wechat token lock wait timed out; refreshing anyway');
      }

      try {
        return await refresh(config, app);
      } finally {
        if (won) {
          // Release only our own lock: a slow refresh may have outlived its TTL
          // and the key may now belong to somebody else.
          const held = await ctx.redis.get(lockKey);
          if (held === token) await ctx.redis.del(lockKey);
        }
      }
    })();

    inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(key);
    }
  }

  /**
   * A token-bearing call that drops the cached token and retries once on a 40001.
   * `form` (built afresh for each attempt, since a sent body is spent) makes it
   * a multipart upload.
   */
  async function authedCall<T>(app: WechatApp, req: WechatCall, form?: () => FormData): Promise<T> {
    const config = await load();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await acquire(app);
      const result = await request(
        config.apiBaseUrl,
        { ...req, query: { ...req.query, access_token: token } },
        form?.(),
      );
      const envelope = envelopeOf(result);
      if (envelope.errcode !== undefined && TOKEN_ERRCODES.has(envelope.errcode) && attempt === 0) {
        await invalidate(app);
        continue;
      }
      return result as T;
    }
    // Unreachable: the loop returns on its second pass.
    throw new DomainError('INTERNAL', { message: '微信接口重试后仍然失败' });
  }

  /** `authedCall`'s binary twin, with the same one-shot retry on a dead token. */
  async function authedBytes(app: WechatApp, req: WechatCall): Promise<WechatBytesResult> {
    const config = await load();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await acquire(app);
      const result = await requestBytes(config.apiBaseUrl, {
        ...req,
        query: { ...req.query, access_token: token },
      });
      if (!result.ok && TOKEN_ERRCODES.has(result.errcode) && attempt === 0) {
        await invalidate(app);
        continue;
      }
      return result;
    }
    throw new DomainError('INTERNAL', { message: '微信接口重试后仍然失败' });
  }

  async function invalidate(app: WechatApp): Promise<void> {
    const config = await load();
    const { appId } = credentials(config, app);
    const key = cacheKey(appId);
    inflight.delete(key);
    await ctx.redis.del(key);
  }

  async function send(
    app: WechatApp,
    path: string,
    body: unknown,
    what: string,
  ): Promise<WechatSendResult> {
    try {
      const envelope = envelopeOf(
        await authedCall(app, { method: 'POST', path, body }),
      ) as WechatEnvelope & { msgid?: number | string };
      const errcode = envelope.errcode ?? 0;
      const result: WechatSendResult = {
        ok: errcode === 0,
        errcode,
        errmsg: envelope.errmsg ?? 'ok',
        ...(envelope.msgid === undefined ? {} : { msgid: String(envelope.msgid) }),
      };
      if (!result.ok)
        ctx.logger.warn({ what, errcode, errmsg: result.errmsg }, 'wechat send failed');
      return result;
    } catch (error) {
      // Transport failures keep throwing: that is the case a retry fixes.
      ctx.logger.warn({ err: error, what }, 'wechat send transport failure');
      throw error;
    }
  }

  return {
    async oaCodeExchange(code) {
      const config = await load();
      const { appId, secret } = credentials(config, 'oa');
      const body = envelopeOf(
        await request(config.apiBaseUrl, {
          method: 'GET',
          path: '/sns/oauth2/access_token',
          query: { appid: appId, secret, code, grant_type: 'authorization_code' },
        }),
      ) as WechatEnvelope & {
        openid?: string;
        unionid?: string;
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };
      if (!body.openid || !body.access_token) {
        throw refused('微信授权失败', '/sns/oauth2/access_token', body);
      }
      return {
        openid: body.openid,
        ...(body.unionid ? { unionid: body.unionid } : {}),
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? '',
        expiresIn: body.expires_in ?? 7200,
        scope: body.scope ?? 'snsapi_base',
      };
    },

    async oaUserInfo(args) {
      const config = await load();
      const body = envelopeOf(
        await request(config.apiBaseUrl, {
          method: 'GET',
          path: '/sns/userinfo',
          query: { access_token: args.accessToken, openid: args.openid, lang: 'zh_CN' },
        }),
      ) as WechatEnvelope & {
        openid?: string;
        unionid?: string;
        nickname?: string;
        headimgurl?: string;
      };
      if (!body.openid) throw refused('获取微信用户信息失败', '/sns/userinfo', body);
      return {
        openid: body.openid,
        ...(body.unionid ? { unionid: body.unionid } : {}),
        ...(body.nickname ? { nickname: body.nickname } : {}),
        ...(body.headimgurl ? { avatarUrl: body.headimgurl } : {}),
      };
    },

    async miniCode2Session(code) {
      const config = await load();
      const { appId, secret } = credentials(config, 'mini');
      const body = envelopeOf(
        await request(config.apiBaseUrl, {
          method: 'GET',
          path: '/sns/jscode2session',
          query: { appid: appId, secret, js_code: code, grant_type: 'authorization_code' },
        }),
      ) as WechatEnvelope & { openid?: string; unionid?: string; session_key?: string };
      if (!body.openid) throw refused('小程序登录失败', '/sns/jscode2session', body);
      return {
        openid: body.openid,
        ...(body.unionid ? { unionid: body.unionid } : {}),
        sessionKey: body.session_key ?? '',
      };
    },

    accessToken: acquire,
    invalidateAccessToken: invalidate,

    sendTemplateMessage(input) {
      return send(
        'oa',
        '/cgi-bin/message/template/send',
        {
          touser: input.touser,
          template_id: input.templateId,
          ...(input.url ? { url: input.url } : {}),
          ...(input.miniprogram ? { miniprogram: input.miniprogram } : {}),
          data: input.data,
        },
        'template-message',
      );
    },

    sendSubscribeMessage(input) {
      return send(
        'mini',
        '/cgi-bin/message/subscribe/send',
        {
          touser: input.touser,
          template_id: input.templateId,
          ...(input.page ? { page: input.page } : {}),
          ...(input.miniprogramState ? { miniprogram_state: input.miniprogramState } : {}),
          data: input.data,
        },
        'subscribe-message',
      );
    },

    call: (app, req) => authedCall(app, req),
    callBytes: authedBytes,
    upload: (app, req) =>
      authedCall(
        app,
        { method: 'POST', path: req.path, ...(req.query ? { query: req.query } : {}) },
        () => {
          const form = new FormData();
          // `new Uint8Array(bytes)` rather than `bytes`: a `Uint8Array<ArrayBufferLike>`
          // is not a `BlobPart` under the DOM lib (it could be backed by a
          // `SharedArrayBuffer`), and the copy is the one-line way to say it is not.
          form.append(
            req.field,
            new Blob([new Uint8Array(req.bytes)], { type: req.contentType }),
            req.filename,
          );
          return form;
        },
      ),
  };
}

/**
 * The client for this request. There is no singleton: credentials live in the
 * config registry and a change must take effect on the next request, not on the
 * next deploy. The only thing that is shared is the token cache, and that is
 * keyed by `appId` in Redis.
 */
export function getWechatClient(ctx: Ctx): WechatCoreClient {
  return createWechatClient(ctx);
}

/**
 * Whether an AppID and AppSecret can get a token, for 「测试」 on the settings
 * screen. The answer is WeChat's own errcode and errmsg.
 *
 * This calls `stable_token` without `force_refresh`, not `/cgi-bin/token`.
 * Asking `/cgi-bin/token` for a token invalidates the one the shop has cached
 * (see point 1 at the top of this file), so a test run would break the live
 * token. A stable token is issued separately and leaves that one alone.
 */
export async function probeWechatCredentials(args: {
  apiBaseUrl: string;
  appId: string;
  secret: string;
}): Promise<{ ok: true; expiresIn: number } | { ok: false; errcode: number; errmsg: string }> {
  const response = await fetch(new URL('/cgi-bin/stable_token', args.apiBaseUrl), {
    method: 'POST',
    signal: AbortSignal.timeout(WECHAT_API_TIMEOUT_MS),
    headers: { accept: 'application/json', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'client_credential',
      appid: args.appId,
      secret: args.secret,
      force_refresh: false,
    }),
  });
  if (!response.ok) {
    return { ok: false, errcode: -1, errmsg: `HTTP ${response.status}` };
  }
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    errcode?: number;
    errmsg?: string;
  };
  if (body.access_token) return { ok: true, expiresIn: body.expires_in ?? 7200 };
  return { ok: false, errcode: body.errcode ?? -1, errmsg: body.errmsg ?? '' };
}
