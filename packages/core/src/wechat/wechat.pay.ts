import type { Ctx } from '../kernel/context';
import { UNEXPLAINED } from '../kernel/error-summary';
import { DomainError } from '../kernel/errors';
import type { Money } from '../kernel/money';
import {
  buildAuthorization,
  buildJsapiPayParams,
  decryptResource,
  nonceStr,
  VERIFY_FAILURE_MESSAGE,
  verifySignedPayload,
} from './wechat.crypto';

/**
 * The WeChat Pay v3 client.
 *
 * Separate from `WechatCoreClient` on purpose: a different host, a different
 * signature scheme, a different credential set, and a blast radius that means
 * `wechat/oa` and `notification` must not be able to reach it by accident.
 *
 * ## The rule that shapes every method here
 *
 * **An unverifiable answer is never converted into a state** (TLS-006). Three
 * outcomes exist, and the caller must be able to tell them apart:
 *
 *  - a verified answer, returned as data;
 *  - a verified *refusal* (`ORDER_NOT_EXIST`, `ORDERPAID`, `NOT_ENOUGH`), returned
 *    as `null` or thrown as `PAYMENT_GATEWAY_REFUSED` with the code in
 *    `details` — the caller knows where it stands;
 *  - anything else — a timeout, a bad signature, an unknown serial, a body that
 *    will not decrypt — thrown as `PAYMENT_STATE_UNKNOWN`. Nothing is released
 *    on that path. Ever.
 *
 * Failing *closed* on an unverifiable signature is right, but without a state
 * for "we do not know" the caller has to guess. Here the not-knowing has a
 * name.
 */

/**
 * What the client needs to talk to the gateway.
 *
 * Declared here rather than imported from `payment/payment.config.ts` because a
 * core domain may reach another only through its `index.ts`, and `payment`
 * importing `wechat` while `wechat` imports `payment` would be a cycle. The
 * payment domain builds this object from its config group; the shapes are kept
 * honest by `paymentCredentials()` in `payment/payment.config.ts`, which
 * declares this as its return type.
 */
export interface WechatPayCredentials {
  mchId: string;
  apiV3Key: string;
  certSerial: string;
  merchantPrivateKey: string;
  platformPublicKeyId: string;
  platformPublicKey: string;
  /** Absolute URLs. The payment domain appends the webhook paths to `notifyBaseUrl`. */
  transactionNotifyUrl: string;
  refundNotifyUrl: string;
  apiBaseUrl: string;
}

export type WechatTradeState =
  'SUCCESS' | 'REFUND' | 'NOTPAY' | 'CLOSED' | 'USERPAYING' | 'PAYERROR';

export interface GatewayTransaction {
  outTradeNo: string;
  transactionId: string | null;
  tradeState: WechatTradeState;
  tradeStateDesc: string;
  /** Integer 分, as the gateway reports it: `amount.total`, the order total we asked for. */
  totalFen: number;
  /**
   * `amount.payer_total`: what the shopper's own money covered, less than
   * `totalFen` when a WeChat 立减 / 代金券 paid part of it. Information only —
   * settlement and refunds use `totalFen` (PAY-013).
   */
  payerTotalFen: number;
  openid: string | null;
  successTime: string | null;
  mchId: string;
  appId: string;
}

export type GatewayRefundStatus = 'SUCCESS' | 'CLOSED' | 'PROCESSING' | 'ABNORMAL';

export interface GatewayRefund {
  outRefundNo: string;
  refundId: string | null;
  outTradeNo: string;
  transactionId: string | null;
  status: GatewayRefundStatus;
  refundFen: number;
  totalFen: number;
  channel: string | null;
  successTime: string | null;
}

export interface PayCreateInput {
  outTradeNo: string;
  description: string;
  amount: Money;
  /** JSAPI and mini-program only. */
  openid?: string;
  /** H5 only. */
  clientIp?: string;
  /** Absolute instant the gateway order stops being collectible. */
  expiresAt: Date;
  /** H5 only: where WeChat sends the shopper afterwards. */
  returnUrl?: string;
  appId: string;
}

export interface RefundCreateInput {
  outRefundNo: string;
  outTradeNo: string;
  transactionId: string;
  /** What this refund gives back. */
  refundAmount: Money;
  /** What the original payment collected. The gateway checks the pair. */
  totalAmount: Money;
  reason?: string;
}

export interface VerifiedNotification {
  notifyId: string;
  eventType: string;
  resource: Record<string, unknown>;
}

export interface WechatPayClient {
  /** `true` once every credential the client needs is present. */
  readonly configured: boolean;
  readonly mchId: string;
  createJsapiTransaction(input: PayCreateInput): Promise<{ prepayId: string }>;
  createH5Transaction(input: PayCreateInput): Promise<{ h5Url: string }>;
  /** `null` = the gateway confirmed it has no such order. */
  queryTransaction(outTradeNo: string): Promise<GatewayTransaction | null>;
  /** Resolves only when the gateway *confirmed* the close (PAY-010). */
  closeTransaction(outTradeNo: string): Promise<void>;
  createRefund(input: RefundCreateInput): Promise<GatewayRefund>;
  queryRefund(outRefundNo: string): Promise<GatewayRefund | null>;
  verifyNotification(args: {
    headers: Record<string, string | null>;
    rawBody: string;
  }): Promise<VerifiedNotification>;
  jsapiPayParams(args: { appId: string; prepayId: string }): ReturnType<typeof buildJsapiPayParams>;
}

// ---------------------------------------------------------------------------

interface GatewayError {
  code?: string;
  message?: string;
  detail?: unknown;
}

/**
 * How long one WeChat Pay call may take, body included. A timeout is a
 * transport failure: `PAYMENT_STATE_UNKNOWN`, never a confirmed answer. Without
 * it a gateway that never answers holds the effects dispatcher (one at a time,
 * 60-second lease) and the cashier's request open indefinitely.
 */
export const WECHAT_PAY_TIMEOUT_MS = 10_000;

/** Business refusals the caller is expected to handle rather than retry blindly. */
const NOT_FOUND_CODES = new Set([
  'ORDER_NOT_EXIST', // v3: 查单、关单
  'ORDERNOTEXIST', // v2 spelling, kept in case a gateway still answers with it
  'RESOURCE_NOT_EXISTS', // v3: 退款查询
  'REFUND_NOT_EXIST',
]);

/** What staff must do about a refund the gateway refused, by its v3 code. */
const REFUND_REFUSAL_MESSAGE: Record<string, string> = {
  NOT_ENOUGH: '微信支付商户号余额不足，请到商户平台充值后重试',
  USER_ACCOUNT_ABNORMAL: '用户微信账户异常，无法原路退回，请线下退款后驳回此退款单',
  FREQUENCY_LIMITED: '退款请求过于频繁，请稍后重试',
};

/**
 * The staff-facing reason for a refused refund (rule 9).
 *
 * `PAYMENT_GATEWAY_REFUSED` carries one generic message whatever the gateway
 * said; the code lives in `details`. Without this, 余额不足 reads as 请稍后重试
 * and every retry fails the same way. `INVALID_REQUEST` covers several business
 * rules (over the refundable amount, past 365 days, over 50 refunds), and the
 * gateway's own Chinese message is the only thing that says which. Anything
 * else keeps the error's own message.
 */
export function refundRefusalMessage(error: unknown): string {
  const fallback = error instanceof Error ? error.message : '退款失败';
  if (!(error instanceof DomainError) || error.code !== 'PAYMENT_GATEWAY_REFUSED') return fallback;
  const { code, message } = (error.details ?? {}) as { code?: string; message?: string };
  if (code === undefined) return fallback;
  const known = REFUND_REFUSAL_MESSAGE[code];
  if (known) return known;
  if (code === 'INVALID_REQUEST') {
    return message ? `微信支付不受理此退款：${message}` : '微信支付不受理此退款';
  }
  return fallback;
}

/** The answer was lost: what staff are told for an unknown result, whichever refund it is. */
export const REFUND_NO_ANSWER = '没有收到微信支付的结果';

/** WeChat Pay's refund states that end a refund without paying it, in staff's words. */
const REFUND_ENDED_MESSAGE: Record<string, string> = {
  CLOSED: '微信支付已关闭这笔退款',
  ABNORMAL: '退款异常：买家的银行卡可能已注销或冻结，请到微信支付商户平台手动处理',
};

/** A refund state that is neither SUCCESS nor PROCESSING, in staff's words (rule 1). */
export function refundEndedMessage(status: string): string {
  return REFUND_ENDED_MESSAGE[status] ?? `微信支付返回退款失败，${UNEXPLAINED}`;
}

function requireConfigured(config: WechatPayCredentials): void {
  const missing = [
    !config.mchId && 'mchId',
    !config.apiV3Key && 'apiV3Key',
    !config.certSerial && 'certSerial',
    !config.merchantPrivateKey && 'merchantPrivateKey',
    !config.platformPublicKeyId && 'platformPublicKeyId',
    !config.platformPublicKey && 'platformPublicKey',
    !config.transactionNotifyUrl && 'notifyBaseUrl',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new DomainError('PAYMENT_NOT_CONFIGURED', { details: { missing } });
  }
}

export function isPaymentConfigured(config: WechatPayCredentials): boolean {
  try {
    requireConfigured(config);
    return true;
  } catch {
    return false;
  }
}

export function createWechatPayClient(ctx: Ctx, config: WechatPayCredentials): WechatPayClient {
  const platformKeys = new Map(
    config.platformPublicKeyId && config.platformPublicKey
      ? [[config.platformPublicKeyId, config.platformPublicKey] as const]
      : [],
  );

  /**
   * One signed request, and the verification of what came back.
   *
   * `unknown` is thrown for anything that leaves the state in doubt, including
   * a 5xx: the gateway may well have accepted the order we just asked it to
   * create, and treating a 502 as "did not happen" is how money gets collected
   * on an order we then cancel (PAYC-002).
   */
  async function call<T>(args: {
    method: 'GET' | 'POST';
    /** Path plus query, exactly as it goes on the wire. */
    urlPath: string;
    body?: unknown;
    /** What to do with a verified business refusal. */
    notFoundIsNull?: boolean;
  }): Promise<T | null> {
    requireConfigured(config);
    const body = args.body === undefined ? '' : JSON.stringify(args.body);
    const timestamp = String(Math.floor(ctx.clock.now().getTime() / 1000));
    const nonce = nonceStr();

    let authorization: string;
    try {
      authorization = buildAuthorization({
        mchId: config.mchId,
        certSerial: config.certSerial,
        merchantPrivateKeyPem: config.merchantPrivateKey,
        method: args.method,
        urlPath: args.urlPath,
        body,
        timestamp,
        nonce,
      });
    } catch (error) {
      // A 商户私钥 that will not parse is a settings mistake, not a crash: nothing
      // was sent, and the shopper is told payment is not set up (the operator's
      // 测试 button names the key). Without this it surfaced as a bare 500.
      ctx.logger.error({ err: error, urlPath: args.urlPath }, 'wechat pay merchant key unusable');
      throw new DomainError('PAYMENT_NOT_CONFIGURED', {
        details: { reason: 'merchant-key-invalid' },
      });
    }

    let response: Response;
    let text: string;
    try {
      response = await fetch(new URL(args.urlPath, config.apiBaseUrl), {
        method: args.method,
        signal: AbortSignal.timeout(WECHAT_PAY_TIMEOUT_MS),
        headers: {
          accept: 'application/json',
          authorization,
          'user-agent': 'shop-wechatpay-v3/1.0',
          ...(body ? { 'content-type': 'application/json; charset=utf-8' } : {}),
          ...(config.platformPublicKeyId ? { 'wechatpay-serial': config.platformPublicKeyId } : {}),
        },
        ...(body ? { body } : {}),
      });
      text = await response.text();
    } catch (error) {
      ctx.logger.warn({ err: error, urlPath: args.urlPath }, 'wechat pay transport failure');
      throw new DomainError('PAYMENT_STATE_UNKNOWN', {
        details: { reason: 'transport', urlPath: args.urlPath },
        cause: error,
      });
    }

    // 204 carries no body and therefore no signature to verify. Only `close`
    // answers this way, and a 204 *is* the gateway's confirmation.
    if (response.status === 204) return null;

    const verdict = verifySignedPayload({
      timestamp: response.headers.get('wechatpay-timestamp'),
      nonce: response.headers.get('wechatpay-nonce'),
      signature: response.headers.get('wechatpay-signature'),
      serial: response.headers.get('wechatpay-serial'),
      body: text,
      platformKeys,
      nowSeconds: Math.floor(ctx.clock.now().getTime() / 1000),
    });

    if (!verdict.ok) {
      ctx.logger.error(
        { urlPath: args.urlPath, status: response.status, reason: verdict.reason },
        'wechat pay response signature not verified',
      );
      // TLS-006: an unverified response never becomes `closed` or `paid`.
      throw new DomainError('PAYMENT_STATE_UNKNOWN', {
        details: { reason: verdict.reason, message: VERIFY_FAILURE_MESSAGE[verdict.reason] },
      });
    }

    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      throw new DomainError('PAYMENT_STATE_UNKNOWN', { details: { reason: 'malformed-json' } });
    }

    if (response.status >= 200 && response.status < 300) return parsed as T;

    const error = (parsed ?? {}) as GatewayError;
    if (args.notFoundIsNull && error.code && NOT_FOUND_CODES.has(error.code)) return null;

    // A 5xx leaves the state genuinely unknown; a 4xx is a decision the gateway
    // has made and stands by.
    if (response.status >= 500) {
      throw new DomainError('PAYMENT_STATE_UNKNOWN', {
        details: { reason: 'gateway-5xx', code: error.code ?? null },
      });
    }
    throw new DomainError('PAYMENT_GATEWAY_REFUSED', {
      details: { code: error.code ?? 'UNKNOWN', message: error.message ?? '' },
    });
  }

  function transactionOf(raw: Record<string, unknown>): GatewayTransaction {
    const amount = (raw.amount ?? {}) as { total?: number; payer_total?: number };
    const payer = (raw.payer ?? {}) as { openid?: string };
    return {
      outTradeNo: String(raw.out_trade_no ?? ''),
      transactionId: raw.transaction_id ? String(raw.transaction_id) : null,
      tradeState: String(raw.trade_state ?? 'PAYERROR') as WechatTradeState,
      tradeStateDesc: String(raw.trade_state_desc ?? ''),
      totalFen: Number(amount.total ?? 0),
      payerTotalFen: Number(amount.payer_total ?? amount.total ?? 0),
      openid: payer.openid ? String(payer.openid) : null,
      successTime: raw.success_time ? String(raw.success_time) : null,
      mchId: String(raw.mchid ?? ''),
      appId: String(raw.appid ?? ''),
    };
  }

  function refundOf(raw: Record<string, unknown>): GatewayRefund {
    const amount = (raw.amount ?? {}) as { refund?: number; total?: number };
    return {
      outRefundNo: String(raw.out_refund_no ?? ''),
      refundId: raw.refund_id ? String(raw.refund_id) : null,
      outTradeNo: String(raw.out_trade_no ?? ''),
      transactionId: raw.transaction_id ? String(raw.transaction_id) : null,
      status: String(raw.status ?? 'PROCESSING') as GatewayRefundStatus,
      refundFen: Number(amount.refund ?? 0),
      totalFen: Number(amount.total ?? 0),
      channel: raw.channel ? String(raw.channel) : null,
      successTime: raw.success_time ? String(raw.success_time) : null,
    };
  }

  /** WeChat wants `2026-02-26T12:30:00+08:00`, not a `Z` instant. */
  function rfc3339(at: Date): string {
    const offsetMinutes = 8 * 60; // the shop is single-tenant, Asia/Shanghai
    const shifted = new Date(at.getTime() + offsetMinutes * 60_000);
    return `${shifted.toISOString().slice(0, 19)}+08:00`;
  }

  return {
    configured: isPaymentConfigured(config),
    mchId: config.mchId,

    async createJsapiTransaction(input) {
      if (!input.openid) throw new DomainError('PAYMENT_OPENID_REQUIRED');
      const result = await call<{ prepay_id?: string }>({
        method: 'POST',
        urlPath: '/v3/pay/transactions/jsapi',
        body: {
          appid: input.appId,
          mchid: config.mchId,
          description: input.description,
          out_trade_no: input.outTradeNo,
          time_expire: rfc3339(input.expiresAt),
          notify_url: config.transactionNotifyUrl,
          amount: { total: input.amount.fen, currency: 'CNY' },
          payer: { openid: input.openid },
        },
      });
      const prepayId = result?.prepay_id;
      if (!prepayId)
        throw new DomainError('PAYMENT_STATE_UNKNOWN', { details: { reason: 'no-prepay-id' } });
      return { prepayId };
    },

    async createH5Transaction(input) {
      const result = await call<{ h5_url?: string }>({
        method: 'POST',
        urlPath: '/v3/pay/transactions/h5',
        body: {
          appid: input.appId,
          mchid: config.mchId,
          description: input.description,
          out_trade_no: input.outTradeNo,
          time_expire: rfc3339(input.expiresAt),
          notify_url: config.transactionNotifyUrl,
          amount: { total: input.amount.fen, currency: 'CNY' },
          scene_info: {
            payer_client_ip: input.clientIp ?? '127.0.0.1',
            h5_info: { type: 'Wap' },
          },
        },
      });
      const h5Url = result?.h5_url;
      if (!h5Url)
        throw new DomainError('PAYMENT_STATE_UNKNOWN', { details: { reason: 'no-h5-url' } });
      return {
        h5Url: input.returnUrl
          ? `${h5Url}${h5Url.includes('?') ? '&' : '?'}redirect_url=${encodeURIComponent(input.returnUrl)}`
          : h5Url,
      };
    },

    async queryTransaction(outTradeNo) {
      const raw = await call<Record<string, unknown>>({
        method: 'GET',
        urlPath: `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(config.mchId)}`,
        notFoundIsNull: true,
      });
      return raw ? transactionOf(raw) : null;
    },

    async closeTransaction(outTradeNo) {
      // A 204 is the confirmation; anything else has already thrown. There is
      // no local "assume it closed" path — PAY-010 is exactly that defect.
      await call({
        method: 'POST',
        urlPath: `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`,
        body: { mchid: config.mchId },
      });
    },

    async createRefund(input) {
      const raw = await call<Record<string, unknown>>({
        method: 'POST',
        urlPath: '/v3/refund/domestic/refunds',
        body: {
          out_trade_no: input.outTradeNo,
          transaction_id: input.transactionId,
          out_refund_no: input.outRefundNo,
          ...(input.reason ? { reason: input.reason } : {}),
          notify_url: config.refundNotifyUrl,
          amount: {
            refund: input.refundAmount.fen,
            total: input.totalAmount.fen,
            currency: 'CNY',
          },
        },
      });
      if (!raw)
        throw new DomainError('PAYMENT_STATE_UNKNOWN', { details: { reason: 'empty-refund' } });
      return refundOf(raw);
    },

    async queryRefund(outRefundNo) {
      // v3 queries a refund by the *merchant refund number*, never by the trade
      // number — so this takes no trade-number argument: one it ignored would
      // let a caller pass the wrong one and get a confident wrong answer.
      const raw = await call<Record<string, unknown>>({
        method: 'GET',
        urlPath: `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`,
        notFoundIsNull: true,
      });
      return raw ? refundOf(raw) : null;
    },

    async verifyNotification({ headers, rawBody }) {
      requireConfigured(config);
      const verdict = verifySignedPayload({
        timestamp: headers['wechatpay-timestamp'] ?? null,
        nonce: headers['wechatpay-nonce'] ?? null,
        signature: headers['wechatpay-signature'] ?? null,
        serial: headers['wechatpay-serial'] ?? null,
        body: rawBody,
        platformKeys,
        nowSeconds: Math.floor(ctx.clock.now().getTime() / 1000),
      });
      if (!verdict.ok) {
        throw new DomainError('PAYMENT_STATE_UNKNOWN', {
          details: { reason: verdict.reason },
          message: VERIFY_FAILURE_MESSAGE[verdict.reason],
        });
      }

      let envelope: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(rawBody);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        envelope = parsed as Record<string, unknown>;
      } catch {
        throw new DomainError('PAYMENT_STATE_UNKNOWN', {
          details: { reason: 'malformed-envelope' },
          message: '通知内容不是合法 JSON 对象',
        });
      }

      const resourceRaw = envelope.resource as
        | { ciphertext?: string; nonce?: string; associated_data?: string; algorithm?: string }
        | undefined;
      if (!resourceRaw?.ciphertext || !resourceRaw.nonce) {
        throw new DomainError('PAYMENT_STATE_UNKNOWN', {
          details: { reason: 'no-resource' },
          message: '通知缺少 resource',
        });
      }

      const resource = decryptResource({
        apiV3Key: config.apiV3Key,
        resource: {
          ciphertext: resourceRaw.ciphertext,
          nonce: resourceRaw.nonce,
          ...(resourceRaw.associated_data === undefined
            ? {}
            : { associated_data: resourceRaw.associated_data }),
          ...(resourceRaw.algorithm === undefined ? {} : { algorithm: resourceRaw.algorithm }),
        },
      });

      return {
        notifyId: String(envelope.id ?? ''),
        eventType: String(envelope.event_type ?? ''),
        resource,
      };
    },

    jsapiPayParams({ appId, prepayId }) {
      return buildJsapiPayParams({
        appId,
        prepayId,
        merchantPrivateKeyPem: config.merchantPrivateKey,
        timestampSeconds: Math.floor(ctx.clock.now().getTime() / 1000),
      });
    },
  };
}
