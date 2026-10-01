import {
  createCipheriv,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Fake WeChat Pay v3 gateway.
 *
 * Why it exists: no test may spend real money or hold real merchant
 * credentials, so the only way payment and refund can be tested end to end is
 * against a gateway we control. Together with the signature vector tests, it
 * is how the v3 client is proved without a live merchant account.
 *
 * Everything security-shaped here is **real**: a real RSA-2048 key pair per
 * instance, real `Wechatpay-Signature` generation over the documented
 * `timestamp\nnonce\nbody\n` message, real verification of the app's
 * `Authorization` signature over `METHOD\nurl\ntimestamp\nnonce\nbody\n`, and
 * real `AEAD_AES_256_GCM`. A fake that signed incorrectly would teach the
 * client's verifier to be wrong too.
 *
 * ## What it now enforces
 *
 * The rules exist because the races this system has to survive are *gateway*
 * races, and a gateway that says yes to everything cannot express them:
 *
 * | Rule                                             | The race it makes testable |
 * | ------------------------------------------------ | -------------------------- |
 * | a paid `out_trade_no` cannot be created again (`ORDERPAID`) | double-submit of the pay button |
 * | a closed one cannot either (`ORDER_CLOSED`)      | pay after cancel |
 * | closing a paid transaction fails (`ORDERPAID`)   | cancel racing the callback (risk §4) |
 * | `time_expire` really expires an unpaid order     | late callback after close |
 * | refunds are cumulative and capped at the total   | two refund requests on one order |
 * | a repeated `out_refund_no` is idempotent, a *changed* one is rejected | duplicate refund submit |
 * | `refundBalanceFen` can force `NOT_ENOUGH`        | the merchant balance failure path |
 * | `dropNext` / `signResponsesWithWrongKey`         | "the answer cannot be trusted" (TLS-006) |
 *
 * Nothing here consults the clock except through `options.now`, so a test with
 * a fake clock can still drive expiry deterministically — or call
 * `expireTransaction()` and not think about time at all.
 */

export interface FakeWechatKeys {
  /** Merchant private key the *app* signs its requests with. */
  merchantPrivateKeyPem: string;
  merchantSerial: string;
  /** Platform key the *gateway* signs notifications with. */
  platformPrivateKeyPem: string;
  platformPublicKeyPem: string;
  platformSerial: string;
  /** APIv3 key used for AEAD_AES_256_GCM. Exactly 32 bytes. */
  apiV3Key: string;
  mchId: string;
  appId: string;
}

export function generateFakeWechatKeys(): FakeWechatKeys {
  const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    merchantPrivateKeyPem: merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    merchantSerial: randomBytes(20).toString('hex').toUpperCase(),
    platformPrivateKeyPem: platform.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    platformPublicKeyPem: platform.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    platformSerial: randomBytes(20).toString('hex').toUpperCase(),
    apiV3Key: randomBytes(16).toString('hex'), // 32 ASCII chars
    mchId: '1900000001',
    appId: 'wx0000000000000001',
  };
}

/** The exact message WeChat Pay v3 signs: `timestamp\nnonce\nbody\n`. */
export function signatureMessage(timestamp: string, nonce: string, body: string): string {
  return `${timestamp}\n${nonce}\n${body}\n`;
}

export function signWithKey(privateKeyPem: string, message: string): string {
  return createSign('RSA-SHA256').update(message, 'utf8').sign(privateKeyPem, 'base64');
}

export function verifyWithKey(
  publicKeyPem: string,
  message: string,
  signatureBase64: string,
): boolean {
  return createVerify('RSA-SHA256')
    .update(message, 'utf8')
    .verify(publicKeyPem, signatureBase64, 'base64');
}

/** `AEAD_AES_256_GCM`, the envelope every v3 notification body uses. */
export function encryptResource(
  apiV3Key: string,
  plaintext: string,
  associatedData: string,
): { ciphertext: string; nonce: string; associated_data: string; algorithm: string } {
  const nonce = randomBytes(12).toString('hex').slice(0, 12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    algorithm: 'AEAD_AES_256_GCM',
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64'),
    nonce,
    associated_data: associatedData,
  };
}

export interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  /** Whether the app's own `Authorization` signature verified. */
  signatureValid: boolean | null;
}

export type FakeTradeState = 'NOTPAY' | 'SUCCESS' | 'CLOSED' | 'REFUND' | 'USERPAYING' | 'PAYERROR';

export interface FakeTransaction {
  outTradeNo: string;
  transactionId: string;
  amountFen: number;
  /**
   * What a WeChat-side 立减 / 代金券 covered, in 分: `payer_total` is
   * `amountFen` minus this, while `total` (and a refund's `amount.total`) stays
   * `amountFen`. Set by `markPaid(…, { discountFen })`.
   */
  discountFen?: number;
  tradeState: FakeTradeState;
  openid: string;
  /** Cumulative refunded 分. The cap every refund is checked against. */
  refundedFen: number;
  /** Epoch ms from `time_expire`, or `null` when the app sent none. */
  expiresAtMs: number | null;
  successTime: string | null;
}

export type FakeRefundStatus = 'PROCESSING' | 'SUCCESS' | 'CLOSED' | 'ABNORMAL';

export interface FakeRefund {
  outRefundNo: string;
  refundId: string;
  outTradeNo: string;
  transactionId: string;
  /** What this one refund gives back. */
  refundFen: number;
  /** What the original transaction collected, as the app declared it. */
  totalFen: number;
  status: FakeRefundStatus;
  createTime: string;
  successTime: string | null;
}

/**
 * Knobs a test flips to force one specific gateway behaviour.
 *
 * Mutable on purpose: `gateway.behaviour.dropNext = true` immediately before
 * the call under test reads better than threading options through a factory,
 * and the one-shot fields reset themselves so a forgotten cleanup cannot leak
 * into the next test.
 */
export interface FakeGatewayBehaviour {
  /**
   * Merchant balance in 分. `null` (the default) means unlimited; a number
   * makes an over-large refund fail with `NOT_ENOUGH`, which is the one refund
   * failure an operator actually meets in production.
   */
  refundBalanceFen: number | null;
  /** What `POST /v3/refund/domestic/refunds` reports. Real gateways say `PROCESSING`. */
  refundStatus: Extract<FakeRefundStatus, 'PROCESSING' | 'SUCCESS'>;
  /**
   * Signs responses and notifications with a key the app does not trust.
   * The app must treat the answer as *unknown*, never as a state (TLS-006).
   */
  signResponsesWithWrongKey: boolean;
  /** One-shot canned error, consumed by the next request whatever it is. */
  failNext: { status: number; code: string; message: string } | null;
  /** One-shot socket destruction: the app sees a transport failure, not a status. */
  dropNext: boolean;
}

export interface NotifyResult {
  status: number;
  body: string;
}

/**
 * A notification as it would arrive on the wire: the exact bytes and the five
 * headers whose signature covers them.
 *
 * Handed out so a test can call the webhook *service* directly — which is the
 * only way to make two deliveries collide inside one statement, since two HTTP
 * requests would be serialised by the listener before they ever reached the
 * database.
 */
export interface SignedNotification {
  headers: Record<string, string>;
  rawBody: string;
}

export interface FakeWechatGateway {
  url: string;
  port: number;
  /**
   * The page an H5 create's `h5_url` sends the phone browser to, standing in
   * for WeChat's H5 cashier: `GET <url>/h5-cashier?out_trade_no=…`. It 302s
   * to the `redirect_url` query parameter the app appends (http/https only),
   * the way WeChat returns the shopper, and otherwise answers a plain 200.
   * It settles nothing — paying stays the test's job (`markPaid` /
   * `postNotify`), so a test keeps control of paid-vs-unpaid timing.
   */
  h5CashierUrl: string;
  keys: FakeWechatKeys;
  /** Every request the app made, in order. */
  calls: RecordedCall[];
  transactions: Map<string, FakeTransaction>;
  /**
   * Every `prepay_id` a create has answered (JSAPI, mini-program, app and the
   * one inside an H5 cashier URL), mapped to its merchant order number. A
   * phone's `wx.requestPayment` names nothing but `package: 'prepay_id=…'`, so
   * this is how an emulated pay sheet finds the transaction it pays.
   */
  prepayIds: Map<string, string>;
  /**
   * The transaction a `prepay_id` (or a whole `prepay_id=…` package) was
   * issued for, or `undefined` for one this gateway never issued.
   */
  transactionForPrepay(prepayIdOrPackage: string): FakeTransaction | undefined;
  /** Keyed by merchant refund number — the number the app is certain it owns. */
  refunds: Map<string, FakeRefund>;
  behaviour: FakeGatewayBehaviour;
  /**
   * Marks a transaction paid, as if the shopper completed payment — with a
   * WeChat-side discount covering `discountFen` of it when given.
   */
  markPaid(outTradeNo: string, options?: { discountFen?: number }): FakeTransaction;
  /** Forces any trade state, for the paths a shopper cannot reach on demand. */
  setTradeState(outTradeNo: string, state: FakeTradeState): FakeTransaction;
  /** Expires an unpaid transaction now, without waiting for `time_expire`. */
  expireTransaction(outTradeNo: string): FakeTransaction;
  /** Settles a refund the way the gateway's asynchronous processing would. */
  markRefunded(outRefundNo: string, status?: FakeRefundStatus): FakeRefund;
  /**
   * Delivers a signed `TRANSACTION.SUCCESS` callback to the app.
   * Returns the app's HTTP status and body so the test can assert the ack.
   */
  postNotify(
    notifyUrl: string,
    input: { outTradeNo: string; eventType?: string; resource?: Record<string, unknown> },
  ): Promise<NotifyResult>;
  /** Delivers a signed refund callback (`REFUND.SUCCESS` and friends). */
  postRefundNotify(
    notifyUrl: string,
    input: { outRefundNo: string; eventType?: string; resource?: Record<string, unknown> },
  ): Promise<NotifyResult>;
  /** The same payment notification, signed but not delivered. */
  signTransactionNotification(input: {
    outTradeNo: string;
    eventType?: string;
    resource?: Record<string, unknown>;
    /** Reuse an earlier notification's id, which is how a replay is spelled. */
    notifyId?: string;
  }): SignedNotification;
  /** The same refund notification, signed but not delivered. */
  signRefundNotification(input: {
    outRefundNo: string;
    eventType?: string;
    resource?: Record<string, unknown>;
    notifyId?: string;
  }): SignedNotification;
  close(): Promise<void>;
  server: Server;
}

export interface FakeWechatGatewayOptions {
  keys?: FakeWechatKeys;
  port?: number;
  /** Epoch ms source. Injected so expiry is deterministic under a fake clock. */
  now?: () => number;
  /**
   * Where an H5 create's `h5_url` points. Defaults to the fake's own
   * `GET /h5-cashier` (see `FakeWechatGateway.h5CashierUrl`).
   */
  h5CashierUrl?: string;
}

/** The four create endpoints; each answers in its own shape. */
export type FakeTradeType = 'jsapi' | 'app' | 'native' | 'h5';

export async function startFakeWechatGateway(
  options: FakeWechatGatewayOptions = {},
): Promise<FakeWechatGateway> {
  const keys = options.keys ?? generateFakeWechatKeys();
  const now = options.now ?? (() => Date.now());
  const calls: RecordedCall[] = [];
  const transactions = new Map<string, FakeTransaction>();
  const prepayIds = new Map<string, string>();
  const refunds = new Map<string, FakeRefund>();
  const behaviour: FakeGatewayBehaviour = {
    refundBalanceFen: null,
    refundStatus: 'PROCESSING',
    signResponsesWithWrongKey: false,
    failNext: null,
    dropNext: false,
  };

  /** Generated on demand: most runs never ask for an untrusted signature. */
  let strangerKeyPem: string | null = null;
  const signingKey = (): string => {
    if (!behaviour.signResponsesWithWrongKey) return keys.platformPrivateKeyPem;
    strangerKeyPem ??= generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    return strangerKeyPem;
  };

  const server = createServer((req, res) => {
    void route(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;

  async function readJson(req: IncomingMessage): Promise<{ raw: string; parsed: unknown }> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      return { raw, parsed: raw.length > 0 ? JSON.parse(raw) : undefined };
    } catch {
      return { raw, parsed: undefined };
    }
  }

  /**
   * Verifies the `Authorization: WECHATPAY2-SHA256-RSA2048 …` header the app
   * must send. Returns `null` when no header was present — a test asserting
   * "the client signs its requests" checks for `true`, not for absence.
   */
  function verifyAppSignature(req: IncomingMessage, body: string): boolean | null {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.includes('WECHATPAY2-SHA256-RSA2048')) return null;
    const field = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(header)?.[1] ?? '';
    const message = `${(req.method ?? 'GET').toUpperCase()}\n${req.url}\n${field('timestamp')}\n${field('nonce_str')}\n${body}\n`;
    const merchantPublic = keys.merchantPrivateKeyPem
      ? publicFromPrivate(keys.merchantPrivateKeyPem)
      : '';
    try {
      return verifyWithKey(merchantPublic, message, field('signature'));
    } catch {
      return false;
    }
  }

  function reply(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    const timestamp = String(Math.floor(now() / 1000));
    const nonce = randomUUID().replace(/-/g, '').slice(0, 32);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      // Responses are signed exactly like notifications, which is what the
      // app's response verifier must check.
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': nonce,
      'wechatpay-serial': keys.platformSerial,
      'wechatpay-signature': signWithKey(signingKey(), signatureMessage(timestamp, nonce, payload)),
    });
    res.end(payload);
  }

  /** A WeChat-shaped refusal: the code is what the app branches on. */
  function fail(res: ServerResponse, status: number, code: string, message: string): void {
    reply(res, status, { code, message });
  }

  /**
   * Lazily applies `time_expire`. WeChat closes an unpaid order when its
   * expiry passes, and the app must be able to meet an order that closed
   * itself — that is the "late callback after close" path.
   */
  function refresh(transaction: FakeTransaction): FakeTransaction {
    if (
      transaction.tradeState === 'NOTPAY' &&
      transaction.expiresAtMs !== null &&
      transaction.expiresAtMs <= now()
    ) {
      transaction.tradeState = 'CLOSED';
    }
    return transaction;
  }

  function lookup(outTradeNo: string): FakeTransaction | undefined {
    const transaction = transactions.get(outTradeNo);
    return transaction ? refresh(transaction) : undefined;
  }

  const h5CashierUrl = options.h5CashierUrl ?? `http://127.0.0.1:${port}/h5-cashier`;

  /**
   * The fake H5 cashier. A browser request, not an API call from the app, so
   * it is neither recorded in `calls` nor subject to failure injection.
   */
  function h5Cashier(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://wxpay.local');
    if ((req.method ?? 'GET').toUpperCase() !== 'GET' || url.pathname !== '/h5-cashier') {
      return false;
    }
    const back = url.searchParams.get('redirect_url');
    const target = back && URL.canParse(back) ? new URL(back) : null;
    if (target && (target.protocol === 'http:' || target.protocol === 'https:')) {
      res.writeHead(302, { location: target.toString() }).end();
    } else {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('fake cashier');
    }
    return true;
  }

  /**
   * A create's answer, by trade type — the shapes WeChat Pay v3 answers:
   * `jsapi` / `app` a `prepay_id`, `native` a `code_url`, `h5` an `h5_url`.
   * Fresh on every call, including a repeat create of the same unpaid order.
   */
  function createAnswer(tradeType: FakeTradeType, outTradeNo: string): Record<string, string> {
    const prepayId = (): string => {
      const minted = `wx${randomBytes(16).toString('hex')}`;
      prepayIds.set(minted, outTradeNo);
      return minted;
    };
    switch (tradeType) {
      case 'h5': {
        const cashier = new URL(h5CashierUrl);
        cashier.searchParams.set('out_trade_no', outTradeNo);
        cashier.searchParams.set('prepay_id', prepayId());
        return { h5_url: cashier.toString() };
      }
      case 'native':
        return { code_url: `weixin://wxpay/bizpayurl?pr=${randomBytes(6).toString('hex')}` };
      default:
        return { prepay_id: prepayId() };
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (h5Cashier(req, res)) return;
    const { raw, parsed } = await readJson(req);
    const url = new URL(req.url ?? '/', 'http://wxpay.local');
    calls.push({
      method: (req.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join(',') : (v ?? ''),
        ]),
      ),
      body: parsed,
      signatureValid: verifyAppSignature(req, raw),
    });

    // One-shot failure injection, checked before anything else so it can stand
    // in for a failure at any point in the gateway.
    if (behaviour.dropNext) {
      behaviour.dropNext = false;
      req.destroy();
      res.destroy();
      return;
    }
    const canned = behaviour.failNext;
    if (canned) {
      behaviour.failNext = null;
      fail(res, canned.status, canned.code, canned.message);
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const body = (parsed ?? {}) as Record<string, unknown>;

    // --- create transaction (one body shape, four answer shapes) -----------
    const createMatch = /^\/v3\/pay\/transactions\/(jsapi|h5|native|app)$/.exec(url.pathname);
    if (method === 'POST' && createMatch) {
      createTransaction(res, body, createMatch[1] as FakeTradeType);
      return;
    }

    // --- query by out_trade_no ---------------------------------------------
    const queryMatch = /^\/v3\/pay\/transactions\/out-trade-no\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && queryMatch) {
      const transaction = lookup(decodeURIComponent(queryMatch[1]!));
      if (!transaction) {
        fail(res, 404, 'ORDER_NOT_EXIST', '订单不存在');
        return;
      }
      reply(res, 200, transactionBody(transaction, keys));
      return;
    }

    // --- close --------------------------------------------------------------
    const closeMatch = /^\/v3\/pay\/transactions\/out-trade-no\/([^/]+)\/close$/.exec(url.pathname);
    if (method === 'POST' && closeMatch) {
      closeTransaction(res, decodeURIComponent(closeMatch[1]!));
      return;
    }

    // --- refund -------------------------------------------------------------
    if (method === 'POST' && url.pathname === '/v3/refund/domestic/refunds') {
      createRefund(res, body);
      return;
    }

    const refundMatch = /^\/v3\/refund\/domestic\/refunds\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && refundMatch) {
      const refund = refunds.get(decodeURIComponent(refundMatch[1]!));
      if (!refund) {
        fail(res, 404, 'RESOURCE_NOT_EXISTS', '退款单不存在');
        return;
      }
      reply(res, 200, refundBody(refund));
      return;
    }

    // --- platform certificates ---------------------------------------------
    if (method === 'GET' && url.pathname === '/v3/certificates') {
      reply(res, 200, { data: [certificateEntry()] });
      return;
    }

    fail(res, 404, 'RESOURCE_NOT_EXISTS', `fake gateway: ${url.pathname} 未实现`);
  }

  function createTransaction(
    res: ServerResponse,
    body: Record<string, unknown>,
    tradeType: FakeTradeType,
  ): void {
    const outTradeNo = String(body.out_trade_no ?? '');
    const amount = (body.amount ?? {}) as { total?: number };
    const totalFen = amount.total ?? 0;

    if (outTradeNo === '') {
      fail(res, 400, 'PARAM_ERROR', '缺少 out_trade_no');
      return;
    }
    // The app must send its own identity on every create. Getting this wrong
    // in production looks like "payments silently go to the wrong merchant".
    if (body.mchid !== undefined && body.mchid !== keys.mchId) {
      fail(res, 400, 'PARAM_ERROR', 'mchid 与商户号不一致');
      return;
    }
    if (body.appid !== undefined && body.appid !== keys.appId) {
      fail(res, 400, 'APPID_MCHID_NOT_MATCH', 'appid 与 mchid 不匹配');
      return;
    }

    const existing = lookup(outTradeNo);
    if (existing) {
      if (existing.tradeState === 'SUCCESS' || existing.tradeState === 'REFUND') {
        fail(res, 400, 'ORDERPAID', '订单已支付');
        return;
      }
      if (existing.tradeState === 'CLOSED') {
        fail(res, 400, 'ORDER_CLOSED', '订单已关闭');
        return;
      }
      if (existing.amountFen !== totalFen) {
        // Same number, different money. WeChat will not let a merchant quietly
        // reprice an order that is already collectible.
        fail(res, 400, 'INVALID_REQUEST', '订单号重复，且金额与原单不一致');
        return;
      }
      // Still unpaid and unchanged: a fresh answer for the same order, which
      // is what makes "tap pay twice" survivable.
      reply(res, 200, createAnswer(tradeType, outTradeNo));
      return;
    }

    const expire = typeof body.time_expire === 'string' ? Date.parse(body.time_expire) : NaN;
    transactions.set(outTradeNo, {
      outTradeNo,
      transactionId: `42000${randomBytes(8).toString('hex')}`,
      amountFen: totalFen,
      tradeState: 'NOTPAY',
      openid: String((body.payer as { openid?: string } | undefined)?.openid ?? 'oFakeOpenid'),
      refundedFen: 0,
      expiresAtMs: Number.isNaN(expire) ? null : expire,
      successTime: null,
    });
    reply(res, 200, createAnswer(tradeType, outTradeNo));
  }

  function closeTransaction(res: ServerResponse, outTradeNo: string): void {
    const transaction = lookup(outTradeNo);
    if (!transaction) {
      fail(res, 404, 'ORDER_NOT_EXIST', '订单不存在');
      return;
    }
    // The heart of the cancel-vs-callback race: money that has arrived cannot
    // be un-arrived by closing the order. The app has to notice and reconcile.
    if (transaction.tradeState === 'SUCCESS' || transaction.tradeState === 'REFUND') {
      fail(res, 400, 'ORDERPAID', '订单已支付，不能关闭');
      return;
    }
    if (
      transaction.tradeState === 'NOTPAY' ||
      transaction.tradeState === 'USERPAYING' ||
      transaction.tradeState === 'PAYERROR'
    ) {
      transaction.tradeState = 'CLOSED';
    }
    // Closing an already-closed order is a success: close must be retryable.
    res.writeHead(204).end();
  }

  function createRefund(res: ServerResponse, body: Record<string, unknown>): void {
    const outRefundNo = String(body.out_refund_no ?? '');
    const amount = (body.amount ?? {}) as { refund?: number; total?: number };
    const refundFen = amount.refund ?? 0;
    const declaredTotal = amount.total ?? 0;

    if (outRefundNo === '') {
      fail(res, 400, 'PARAM_ERROR', '缺少 out_refund_no');
      return;
    }

    const transaction =
      (body.out_trade_no !== undefined ? lookup(String(body.out_trade_no)) : undefined) ??
      [...transactions.values()].find((t) => t.transactionId === String(body.transaction_id ?? ''));

    const existing = refunds.get(outRefundNo);
    if (existing) {
      // Idempotent by merchant refund number — the app retries on an unknown
      // answer, and a retry must not refund twice.
      if (existing.refundFen !== refundFen) {
        fail(res, 400, 'INVALID_REQUEST', '退款单号重复，且金额与原单不一致');
        return;
      }
      reply(res, 200, refundBody(existing));
      return;
    }

    if (!transaction) {
      fail(res, 404, 'RESOURCE_NOT_EXISTS', '原订单不存在');
      return;
    }
    if (transaction.tradeState !== 'SUCCESS' && transaction.tradeState !== 'REFUND') {
      fail(res, 403, 'TRADE_ERROR', '订单未支付，不能退款');
      return;
    }
    // `amount.total` is the app asserting what the original payment collected.
    // If that assertion is wrong its books are wrong, and the gateway is the
    // last line of defence — so it is checked whenever it is sent. (An omitted
    // total is left alone rather than treated as zero: the real API requires
    // the field, and a caller that skips it is out of scope here, not lying.)
    if (amount.total !== undefined && declaredTotal !== transaction.amountFen) {
      fail(res, 400, 'PARAM_ERROR', '原订单金额与实际不一致');
      return;
    }
    if (refundFen <= 0 || transaction.refundedFen + refundFen > transaction.amountFen) {
      fail(res, 403, 'REFUND_FEE_MISMATCH', '累计退款金额超过支付金额');
      return;
    }
    if (behaviour.refundBalanceFen !== null && refundFen > behaviour.refundBalanceFen) {
      fail(res, 403, 'NOT_ENOUGH', '商户可用余额不足');
      return;
    }

    if (behaviour.refundBalanceFen !== null) behaviour.refundBalanceFen -= refundFen;
    transaction.refundedFen += refundFen;
    transaction.tradeState = 'REFUND';

    const status = behaviour.refundStatus;
    const createTime = new Date(now()).toISOString();
    const refund: FakeRefund = {
      outRefundNo,
      refundId: `50000${randomBytes(8).toString('hex')}`,
      outTradeNo: transaction.outTradeNo,
      transactionId: transaction.transactionId,
      refundFen,
      totalFen: transaction.amountFen,
      status,
      createTime,
      successTime: status === 'SUCCESS' ? createTime : null,
    };
    refunds.set(outRefundNo, refund);
    reply(res, 200, refundBody(refund));
  }

  /**
   * A genuinely encrypted `/v3/certificates` payload.
   *
   * The encrypted blob is the platform *public key* PEM rather than an X.509
   * certificate: Node cannot mint a certificate without a third-party
   * dependency, and the client verifies a key by id in either mode, so the
   * shape and the crypto are what matter here.
   */
  function certificateEntry(): Record<string, unknown> {
    const effective = new Date(now());
    const expire = new Date(now() + 365 * 24 * 3600 * 1000);
    return {
      serial_no: keys.platformSerial,
      effective_time: effective.toISOString(),
      expire_time: expire.toISOString(),
      encrypt_certificate: encryptResource(keys.apiV3Key, keys.platformPublicKeyPem, 'certificate'),
    };
  }

  /** Signs one envelope. The single place the notification bytes are produced. */
  function sign(notification: Record<string, unknown>): SignedNotification {
    const rawBody = JSON.stringify(notification);
    const timestamp = String(Math.floor(now() / 1000));
    const nonce = randomUUID().replace(/-/g, '').slice(0, 32);
    return {
      rawBody,
      headers: {
        'content-type': 'application/json',
        'wechatpay-timestamp': timestamp,
        'wechatpay-nonce': nonce,
        'wechatpay-serial': keys.platformSerial,
        'wechatpay-signature': signWithKey(
          signingKey(),
          signatureMessage(timestamp, nonce, rawBody),
        ),
      },
    };
  }

  async function deliver(
    notifyUrl: string,
    notification: Record<string, unknown>,
  ): Promise<NotifyResult> {
    const signed = sign(notification);
    const response = await fetch(notifyUrl, {
      method: 'POST',
      headers: signed.headers,
      body: signed.rawBody,
    });
    return { status: response.status, body: await response.text() };
  }

  function transactionEnvelope(input: {
    outTradeNo: string;
    eventType?: string;
    resource?: Record<string, unknown>;
    notifyId?: string;
  }): Record<string, unknown> {
    const transaction = transactions.get(input.outTradeNo);
    if (!transaction) throw new Error(`fake gateway: 未知交易 ${input.outTradeNo}`);
    const plaintext = JSON.stringify(
      input.resource ?? transactionBody({ ...transaction, tradeState: 'SUCCESS' }, keys),
    );
    return {
      id: input.notifyId ?? randomUUID(),
      create_time: new Date(now()).toISOString(),
      event_type: input.eventType ?? 'TRANSACTION.SUCCESS',
      resource_type: 'encrypt-resource',
      summary: '支付成功',
      resource: encryptResource(keys.apiV3Key, plaintext, 'transaction'),
    };
  }

  function refundEnvelope(input: {
    outRefundNo: string;
    eventType?: string;
    resource?: Record<string, unknown>;
    notifyId?: string;
  }): Record<string, unknown> {
    const refund = refunds.get(input.outRefundNo);
    if (!refund) throw new Error(`fake gateway: 未知退款单 ${input.outRefundNo}`);
    const eventType = input.eventType ?? 'REFUND.SUCCESS';
    const plaintext = JSON.stringify(
      input.resource ?? refundNotifyBody(refund, keys, eventType, now),
    );
    return {
      id: input.notifyId ?? randomUUID(),
      create_time: new Date(now()).toISOString(),
      event_type: eventType,
      resource_type: 'encrypt-resource',
      summary: '退款成功',
      // Refund notifications use a different associated_data than payment
      // ones; a client that hard-codes 'transaction' fails to decrypt here.
      resource: encryptResource(keys.apiV3Key, plaintext, 'refund'),
    };
  }

  return {
    url: `http://127.0.0.1:${port}`,
    h5CashierUrl,
    port,
    keys,
    calls,
    transactions,
    prepayIds,
    transactionForPrepay(prepayIdOrPackage) {
      const prepayId = prepayIdOrPackage.startsWith('prepay_id=')
        ? prepayIdOrPackage.slice('prepay_id='.length)
        : prepayIdOrPackage;
      const outTradeNo = prepayIds.get(prepayId);
      return outTradeNo === undefined ? undefined : transactions.get(outTradeNo);
    },
    refunds,
    behaviour,
    server,
    markPaid(outTradeNo, options) {
      const transaction = transactions.get(outTradeNo);
      if (!transaction) throw new Error(`fake gateway: 未知交易 ${outTradeNo}`);
      transaction.tradeState = 'SUCCESS';
      if (options?.discountFen !== undefined) transaction.discountFen = options.discountFen;
      transaction.successTime ??= new Date(now()).toISOString();
      return transaction;
    },
    setTradeState(outTradeNo, state) {
      const transaction = transactions.get(outTradeNo);
      if (!transaction) throw new Error(`fake gateway: 未知交易 ${outTradeNo}`);
      transaction.tradeState = state;
      if (state === 'SUCCESS' || state === 'REFUND') {
        transaction.successTime ??= new Date(now()).toISOString();
      }
      return transaction;
    },
    expireTransaction(outTradeNo) {
      const transaction = transactions.get(outTradeNo);
      if (!transaction) throw new Error(`fake gateway: 未知交易 ${outTradeNo}`);
      transaction.expiresAtMs = now();
      return refresh(transaction);
    },
    markRefunded(outRefundNo, status = 'SUCCESS') {
      const refund = refunds.get(outRefundNo);
      if (!refund) throw new Error(`fake gateway: 未知退款单 ${outRefundNo}`);
      refund.status = status;
      refund.successTime = status === 'SUCCESS' ? new Date(now()).toISOString() : null;
      if (status === 'CLOSED' || status === 'ABNORMAL') {
        const transaction = transactions.get(refund.outTradeNo);
        if (transaction) transaction.refundedFen -= refund.refundFen;
      }
      return refund;
    },
    async postNotify(notifyUrl, input) {
      return deliver(notifyUrl, transactionEnvelope(input));
    },
    async postRefundNotify(notifyUrl, input) {
      return deliver(notifyUrl, refundEnvelope(input));
    },
    signTransactionNotification(input) {
      return sign(transactionEnvelope(input));
    },
    signRefundNotification(input) {
      return sign(refundEnvelope(input));
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function transactionBody(transaction: FakeTransaction, keys: FakeWechatKeys) {
  const paid = transaction.tradeState === 'SUCCESS' || transaction.tradeState === 'REFUND';
  return {
    appid: keys.appId,
    mchid: keys.mchId,
    out_trade_no: transaction.outTradeNo,
    transaction_id: transaction.transactionId,
    trade_type: 'JSAPI',
    trade_state: transaction.tradeState,
    trade_state_desc: TRADE_STATE_DESC[transaction.tradeState],
    bank_type: 'OTHERS',
    success_time: transaction.successTime ?? new Date().toISOString(),
    payer: { openid: transaction.openid },
    amount: {
      total: transaction.amountFen,
      payer_total: paid ? transaction.amountFen - (transaction.discountFen ?? 0) : 0,
      currency: 'CNY',
    },
  };
}

const TRADE_STATE_DESC: Record<FakeTradeState, string> = {
  SUCCESS: '支付成功',
  REFUND: '转入退款',
  NOTPAY: '订单未支付',
  CLOSED: '已关闭',
  USERPAYING: '用户支付中',
  PAYERROR: '支付失败',
};

function refundBody(refund: FakeRefund) {
  return {
    refund_id: refund.refundId,
    out_refund_no: refund.outRefundNo,
    transaction_id: refund.transactionId,
    out_trade_no: refund.outTradeNo,
    channel: 'ORIGINAL',
    user_received_account: '支付用户零钱',
    create_time: refund.createTime,
    success_time: refund.successTime,
    status: refund.status,
    funds_account: 'AVAILABLE',
    amount: {
      total: refund.totalFen,
      refund: refund.refundFen,
      payer_total: refund.totalFen,
      payer_refund: refund.refundFen,
      currency: 'CNY',
    },
    promotion_detail: [],
  };
}

function refundNotifyBody(
  refund: FakeRefund,
  keys: FakeWechatKeys,
  eventType: string,
  now: () => number,
) {
  const status = eventType.startsWith('REFUND.')
    ? (eventType.slice('REFUND.'.length) as FakeRefundStatus)
    : refund.status;
  return {
    mchid: keys.mchId,
    out_trade_no: refund.outTradeNo,
    transaction_id: refund.transactionId,
    out_refund_no: refund.outRefundNo,
    refund_id: refund.refundId,
    refund_status: status,
    success_time: status === 'SUCCESS' ? (refund.successTime ?? new Date(now()).toISOString()) : '',
    user_received_account: '支付用户零钱',
    amount: {
      total: refund.totalFen,
      refund: refund.refundFen,
      payer_total: refund.totalFen,
      payer_refund: refund.refundFen,
    },
  };
}

/** Derives the public key of a PKCS#8 private key, for verifying what the app signed. */
function publicFromPrivate(privateKeyPem: string): string {
  return createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
}
