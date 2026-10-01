import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake `api.weixin.qq.com` — the Official Account management endpoints, and
 * the mini-program ones that share the same transport.
 *
 * `fake-gateway.ts` next door speaks WeChat **Pay** v3: a different host, a
 * different auth scheme and a different body format. This one speaks the
 * `cgi-bin` / `sns` / `wxa` endpoints the shop calls — the access token,
 * `message/template/send`, `message/subscribe/send`,
 * `menu/create`, `menu/delete`, `qrcode/create`, `ticket/getticket`,
 * `media/upload`, the material store, `sns/jscode2session`,
 * `wxa/business/getuserphonenumber`, `wxa/getwxacodeunlimit` and the four
 * 发货信息管理 endpoints under `wxa/sec/order/` (see "Shipping" below). Nothing in the
 * test suite may reach the real WeChat, and the client's retry rules
 * (`40001 → drop the token and try once more`) only mean anything against a
 * server that can actually refuse.
 *
 * It lives in `@shop/testing` rather than in a domain because several surfaces
 * need it (OA management, storefront sign-in, mini-program codes, the
 * notification channels), and a test helper imported across a domain boundary
 * is exactly what the conventions forbid.
 *
 * ## Two credential pairs, one process
 *
 * `cgi-bin/token` accepts either the OA pair or the mini pair and remembers
 * which app each token belongs to, so presenting an OA token to a `wxa/*`
 * endpoint is refused the way WeChat refuses it. "The mini-program credentials
 * were never filled in and the OA's were used instead" is a real
 * misconfiguration; a fake that shrugged at it would hide it.
 *
 * ## Codes are seeded, never guessed
 *
 * `setMiniCode()` and `setPhoneCode()` say what a `wx.login()` / `getPhoneNumber`
 * code redeems to. An unseeded code is `40029 invalid code`, which is what a
 * forged one really looks like — so the refusal path is the default rather
 * than a special mode a test has to remember to ask for.
 *
 * Both kinds are **single-use**, as WeChat's are: the second redemption of a
 * code is `40163 code been used`, so a client that replays a `wx.login()` code
 * (or a server that redeems one twice) fails here as it would on a phone.
 *
 * ## Device mode (opt-in, off by default)
 *
 * A real phone's `wx.login()` code was issued by the real WeChat, so no test
 * can seed it. `startFakeOaServer({ deviceMode: true })` lets the device check
 * (docs/mini/device-check.md, backend B) sign in anyway: an **unseeded,
 * well-formed** code (`DEVICE_CODE`, WeChat's own alphabet and length range)
 * redeems to `openid = odev_<hash of the code>` and a phone code to a
 * `139…` number from the same kind of hash — deterministic, so a log line can
 * be traced back. `deviceMode: { openid, phone }` pins them instead, so one
 * tester stays one shopper across cold starts (each launch has a new code).
 * Seeded codes still win, a malformed one is still `40029`, and every code is
 * still single-use. Never on in a test that proves a refusal.
 *
 * ## Shipping (小程序发货信息管理)
 *
 * `wxa/sec/order/upload_shipping_info` keeps one record per payment
 * (`tradeOrders`, keyed `tx:<transaction_id>` or `mch:<mchid>:<out_trade_no>`)
 * and enforces the rules the shop has to get right, with WeChat's codes:
 *
 * - 分拆发货 (`delivery_mode: 2`) only for 实体物流 (`logistics_type: 1`) —
 *   `10060006` otherwise;
 * - `express_company` and `tracking_no` for 实体物流; `receiver_contact`, masked,
 *   for 顺丰 (`SF`); `item_desc` at most 120 characters; `upload_time` RFC 3339;
 *   the payer's openid — `47001` for any of them missing;
 * - once everything is reported, **one** re-upload (重新发货) is allowed:
 *   an identical one is `10060023`, a second different one `10060003`;
 * - a refunded payment (`order_state` 5, via `setTradeOrderState`) is `10060004`.
 *
 * `get_order` reports `order_state` (seed or move it with `setTradeOrderState`;
 * an unknown payment is `10060001`), `set_msg_jump_path` stores `msgJumpPath`,
 * and `is_trade_managed` answers `behaviour.tradeManaged` for our appid.
 *
 * ## Content security (内容安全)
 *
 * `wxa/msg_sec_check` (version 2) answers `risky` (label 20002) for text
 * containing one of `behaviour.secCheckRiskyWords`, `review` (label 21000) for
 * one of `behaviour.secCheckReviewWords`, and `pass` (label 100) otherwise; an
 * openid is required (`40003`). `wxa/media_check_async` records the request in
 * `mediaChecks` and answers a fresh `trace_id`; the verdict arrives later as
 * the `wxa_media_check` push, which `mediaCheckPush(traceId, suggest)` builds
 * (feed it through `buildMiniPush`). `behaviour.failSecCheck` /
 * `behaviour.failMediaCheck` refuse every call while set: WeChat being down.
 */

export interface FakeOaCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  /** The `access_token` the app sent, so a test can prove it used a fresh one. */
  accessToken: string | null;
}

export interface FakeOaMaterial {
  mediaId: string;
  kind: 'image' | 'voice' | 'video' | 'news';
  url: string | null;
  updateTime: number;
}

export interface FakeOaBehaviour {
  /** One-shot `{errcode, errmsg}` consumed by the next `cgi-bin` call. */
  failNext: { errcode: number; errmsg: string } | null;
  /** Every `menu/create` is refused with this until it is cleared. */
  failMenu: { errcode: number; errmsg: string } | null;
  /** How many seconds `ticket/getticket` claims its ticket is good for. */
  ticketExpiresIn: number;
  /** One-shot socket destruction: the app sees a transport failure. */
  dropNext: boolean;
  /**
   * While set, `wxa/getwxacodeunlimit` answers this JSON body instead of the
   * PNG. WeChat really does answer 200 `application/json` on failure and 200
   * `image/*` on success, which is why the caller has to look at the bytes.
   */
  failWxaCode: { errcode: number; errmsg: string } | null;
  /** While set, every `wxa/sec/order/upload_shipping_info` is refused with this. */
  failShipping: { errcode: number; errmsg: string } | null;
  /** What `is_trade_managed` answers. */
  tradeManaged: boolean;
  /** Text containing any of these is `risky`. Default `['违规测试']`. */
  secCheckRiskyWords: string[];
  /** Text containing any of these (and no risky word) is `review`. Default `['待定测试']`. */
  secCheckReviewWords: string[];
  /** While set, every `wxa/msg_sec_check` is refused with this. */
  failSecCheck: { errcode: number; errmsg: string } | null;
  /** While set, every `wxa/media_check_async` is refused with this. */
  failMediaCheck: { errcode: number; errmsg: string } | null;
}

/** One `media_check_async` WeChat accepted. */
export interface FakeMediaCheck {
  traceId: string;
  mediaUrl: string;
  openid: string;
  scene: number;
}

/** One payment as 发货信息管理 sees it. */
export interface FakeTradeOrder {
  /** 1 待发货, 2 已发货, 3 确认收货, 4 交易完成, 5 已退款, 6 资金待结算. */
  orderState: number;
  /** Every accepted `upload_shipping_info` body, in order. */
  uploads: Array<Record<string, unknown>>;
  /** Set once `is_all_delivered` (or a unified upload) was accepted. */
  allDelivered: boolean;
  /** The one 重新发货 is spent. */
  corrected: boolean;
}

/** What a seeded `wx.login()` code redeems to. */
export interface FakeMiniSession {
  openid: string;
  unionid?: string;
  sessionKey?: string;
}

/** What a seeded `getPhoneNumber` code redeems to. */
export interface FakePhoneNumber {
  /** Without the country code — `purePhoneNumber`, which is what the shop stores. */
  phone: string;
  countryCode?: string;
}

export interface FakeOaServer {
  url: string;
  appId: string;
  appSecret: string;
  /** The mini-program pair. `cgi-bin/token` accepts it too. */
  miniAppId: string;
  miniAppSecret: string;
  calls: FakeOaCall[];
  /** Permanent material, keyed by media id — what `batchget_material` reports. */
  material: Map<string, FakeOaMaterial>;
  /** Scene strings `qrcode/create` has issued, in order. */
  scenes: string[];
  /** `{ page, scene }` of every `wxa/getwxacodeunlimit` that produced a PNG, in order. */
  miniCodes: Array<{ page: string; scene: string }>;
  behaviour: FakeOaBehaviour;
  /** Access tokens handed out, newest last. */
  tokens: string[];
  /** The last live menu tree `menu/create` accepted, or `null`. */
  publishedMenu: unknown;
  addMaterial(material: Omit<FakeOaMaterial, 'updateTime'> & { updateTime?: number }): void;
  /** Whether device mode is on (`startFakeOaServer({ deviceMode })`); off by default. */
  readonly deviceMode: FakeDeviceMode;
  /** Teach `sns/jscode2session` one code, good once. Anything else is `40029`; a spent one `40163`. */
  setMiniCode(code: string, session: FakeMiniSession): void;
  /** Teach `wxa/business/getuserphonenumber` one code, good once; the same rules. */
  setPhoneCode(code: string, phone: FakePhoneNumber): void;
  /** 发货信息管理's record per payment, keyed `tx:<transaction_id>` or `mch:<mchid>:<out_trade_no>`. */
  tradeOrders: Map<string, FakeTradeOrder>;
  /** The record for one transaction id, if WeChat has one. */
  tradeOrder(transactionId: string): FakeTradeOrder | undefined;
  /** Seed or move a payment's `order_state` (3 = the buyer confirmed, 5 = refunded). */
  setTradeOrderState(transactionId: string, orderState: number): void;
  /** What `set_msg_jump_path` last stored, or `null`. */
  readonly msgJumpPath: string | null;
  /** Every accepted `media_check_async`, in order. */
  mediaChecks: FakeMediaCheck[];
  /**
   * The decrypted `wxa_media_check` push WeChat would send for one trace id
   * (version 2, JSON). Wrap it with `buildMiniPush` to deliver it.
   */
  mediaCheckPush(
    traceId: string,
    suggest: 'pass' | 'review' | 'risky',
    options?: { label?: number; createTime?: number },
  ): Record<string, unknown>;
  callsTo(path: string): FakeOaCall[];
  reset(): void;
  close(): Promise<void>;
  server: Server;
}

/**
 * Device mode (see the file comment). `true` maps each code to its own fake
 * identity; the fields pin one.
 */
export type FakeDeviceMode = boolean | { openid?: string | undefined; phone?: string | undefined };

/** What a real `wx.login()` / `getPhoneNumber` code looks like: WeChat's alphabet, 16–128 long. */
export const DEVICE_CODE = /^[0-9A-Za-z_-]{16,128}$/;

/** The identity device mode gives an unseeded code, or `null` when the code is not accepted. */
export function deviceIdentity(
  mode: FakeDeviceMode,
  kind: 'login' | 'phone',
  code: string,
): string | null {
  if (mode === false || !DEVICE_CODE.test(code)) return null;
  const pinned = mode === true ? undefined : kind === 'login' ? mode.openid : mode.phone;
  if (pinned) return pinned;
  const digest = createHash('sha256').update(`${kind}:${code}`).digest();
  if (kind === 'login') return `odev_${digest.toString('base64url').slice(0, 23)}`;
  return `139${String(digest.readUInt32BE(0) % 100_000_000).padStart(8, '0')}`;
}

const APP_ID = 'wxfakeoa0000000001';
const APP_SECRET = 'fake-oa-app-secret-0000000000001';
const MINI_APP_ID = 'wxfakemini000000001';
const MINI_APP_SECRET = 'fake-mini-app-secret-000000001';

/**
 * A real 1×1 PNG, so a caller that sniffs the magic bytes before storing them
 * (the storage domain does) sees a picture rather than a rejection.
 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const DEFAULT_RISKY_WORDS = ['违规测试'] as const;
const DEFAULT_REVIEW_WORDS = ['待定测试'] as const;

/** WeChat's own cap on the `scene` string. */
const SCENE_MAX_BYTES = 32;

export async function startFakeOaServer(
  options: { port?: number; deviceMode?: FakeDeviceMode } = {},
): Promise<FakeOaServer> {
  const deviceMode: FakeDeviceMode = options.deviceMode ?? false;
  const calls: FakeOaCall[] = [];
  const material = new Map<string, FakeOaMaterial>();
  const scenes: string[] = [];
  const miniCodes: Array<{ page: string; scene: string }> = [];
  const tokens: string[] = [];
  /** token → which app asked for it, so a `wxa/*` call can be checked. */
  const tokenApp = new Map<string, 'oa' | 'mini'>();
  const miniSessions = new Map<string, FakeMiniSession>();
  const phoneCodes = new Map<string, FakePhoneNumber>();
  /** Codes already redeemed, which WeChat answers `40163` rather than `40029`. */
  const spentCodes = new Set<string>();
  const behaviour: FakeOaBehaviour = {
    failNext: null,
    failMenu: null,
    ticketExpiresIn: 7200,
    dropNext: false,
    failWxaCode: null,
    failShipping: null,
    tradeManaged: true,
    secCheckRiskyWords: [...DEFAULT_RISKY_WORDS],
    secCheckReviewWords: [...DEFAULT_REVIEW_WORDS],
    failSecCheck: null,
    failMediaCheck: null,
  };
  const tradeOrders = new Map<string, FakeTradeOrder>();
  let msgJumpPath: string | null = null;
  const mediaChecks: FakeMediaCheck[] = [];
  // Never reset: trace ids are unique in the shop's database across tests.
  let traceSeq = 0;
  const traceRun = randomBytes(4).toString('hex');
  let publishedMenu: unknown = null;
  let issued = 0;
  let messageSeq = 0;
  let mediaSequence = 0;

  const server = createServer((req, res) => {
    void route(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;

  async function readBody(req: IncomingMessage): Promise<{ raw: string; parsed: unknown }> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      return { raw, parsed: raw.length > 0 ? JSON.parse(raw) : undefined };
    } catch {
      // A multipart upload is not JSON, and the shape of the bytes is not what
      // any of these tests are about — the handle WeChat answers with is.
      return { raw, parsed: undefined };
    }
  }

  function json(res: ServerResponse, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(payload);
  }

  /** WeChat answers a successful `getwxacodeunlimit` with image bytes, status 200. */
  function png(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG_1X1.length) });
    res.end(PNG_1X1);
  }

  /** `upload_shipping_info`, with the rules the module comment lists. */
  function uploadShipping(body: Record<string, unknown>): { errcode: number; errmsg: string } {
    if (behaviour.failShipping) return behaviour.failShipping;
    const bad = (what: string) => ({ errcode: 47001, errmsg: `data format error: ${what}` });
    const orderKey = (body['order_key'] ?? {}) as Record<string, unknown>;
    const key =
      orderKey['order_number_type'] === 2 && typeof orderKey['transaction_id'] === 'string'
        ? `tx:${orderKey['transaction_id']}`
        : orderKey['order_number_type'] === 1 &&
            typeof orderKey['mchid'] === 'string' &&
            typeof orderKey['out_trade_no'] === 'string'
          ? `mch:${orderKey['mchid']}:${orderKey['out_trade_no']}`
          : null;
    if (key === null) return bad('order_key');
    const logisticsType = body['logistics_type'];
    const deliveryMode = body['delivery_mode'];
    if (![1, 2, 3, 4].includes(logisticsType as number)) return bad('logistics_type');
    if (deliveryMode !== 1 && deliveryMode !== 2) return bad('delivery_mode');
    if (deliveryMode === 2 && logisticsType !== 1) {
      return { errcode: 10060006, errmsg: '非快递发货时不允许分拆发货' };
    }
    const list = body['shipping_list'];
    if (!Array.isArray(list) || list.length === 0 || list.length > 15) return bad('shipping_list');
    for (const item of list as Array<Record<string, unknown>>) {
      const desc = item['item_desc'];
      if (typeof desc !== 'string' || desc === '' || [...desc].length > 120)
        return bad('item_desc');
      if (logisticsType === 1) {
        if (typeof item['tracking_no'] !== 'string' || item['tracking_no'] === '') {
          return bad('tracking_no');
        }
        if (typeof item['express_company'] !== 'string' || item['express_company'] === '') {
          return bad('express_company');
        }
        if (item['express_company'] === 'SF') {
          const contact = (item['contact'] ?? {}) as Record<string, unknown>;
          const receiver = contact['receiver_contact'];
          if (typeof receiver !== 'string' || !/^\d{0,3}\*{4}\d{4}$/.test(receiver)) {
            return bad('contact.receiver_contact (顺丰必填且需掩码)');
          }
        }
      }
    }
    const uploadTime = body['upload_time'];
    if (
      typeof uploadTime !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/.test(uploadTime)
    ) {
      return bad('upload_time');
    }
    const payer = (body['payer'] ?? {}) as Record<string, unknown>;
    if (typeof payer['openid'] !== 'string' || payer['openid'] === '') return bad('payer.openid');

    const order = tradeOrders.get(key) ?? {
      orderState: 1,
      uploads: [],
      allDelivered: false,
      corrected: false,
    };
    tradeOrders.set(key, order);
    if (order.orderState === 5) return { errcode: 10060004, errmsg: '支付单处于不可发货的状态' };
    if (order.allDelivered) {
      if (order.orderState !== 2) return { errcode: 10060004, errmsg: '支付单处于不可发货的状态' };
      const same = order.uploads.some((earlier) => sameShipping(earlier, body));
      if (same) return { errcode: 10060023, errmsg: '发货信息未更新' };
      if (order.corrected) return { errcode: 10060003, errmsg: '已使用重新发货机会' };
      order.corrected = true;
      order.uploads.push(body);
      return { errcode: 0, errmsg: 'ok' };
    }
    if (order.uploads.some((earlier) => sameShipping(earlier, body))) {
      return { errcode: 10060023, errmsg: '发货信息未更新' };
    }
    order.uploads.push(body);
    if (deliveryMode === 1 || body['is_all_delivered'] === true) {
      order.allDelivered = true;
      order.orderState = 2;
    }
    return { errcode: 0, errmsg: 'ok' };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { raw, parsed } = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://oa.local');
    const query = Object.fromEntries(url.searchParams);
    calls.push({
      method: (req.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query,
      body: parsed ?? raw,
      accessToken: query['access_token'] ?? null,
    });

    if (behaviour.dropNext) {
      behaviour.dropNext = false;
      req.destroy();
      res.destroy();
      return;
    }

    /**
     * The stable token, which 设置 → 「测试 AppSecret」 probes with: a POST with
     * the pair in a JSON body. The real one hands out the *same* token until it
     * expires; the probe only reads whether one came back.
     */
    if (url.pathname === '/cgi-bin/stable_token' && req.method === 'POST') {
      const body = (parsed ?? {}) as Record<string, unknown>;
      const known =
        (body['appid'] === APP_ID && body['secret'] === APP_SECRET) ||
        (body['appid'] === MINI_APP_ID && body['secret'] === MINI_APP_SECRET);
      if (!known) {
        json(res, { errcode: 40013, errmsg: 'invalid appid' });
        return;
      }
      json(res, { access_token: 'FAKE_STABLE_TOKEN', expires_in: 7200 });
      return;
    }

    if (url.pathname === '/cgi-bin/token') {
      const app =
        query['appid'] === APP_ID && query['secret'] === APP_SECRET
          ? 'oa'
          : query['appid'] === MINI_APP_ID && query['secret'] === MINI_APP_SECRET
            ? 'mini'
            : null;
      if (app === null) {
        json(res, { errcode: 40013, errmsg: 'invalid appid' });
        return;
      }
      issued += 1;
      const token = `FAKE_TOKEN_${issued}`;
      tokens.push(token);
      tokenApp.set(token, app);
      json(res, { access_token: token, expires_in: 7200 });
      return;
    }

    /**
     * `wx.login()`'s code. No access token: the appid/secret pair *is* the
     * credential, which is why this endpoint sits above the token gate.
     */
    if (url.pathname === '/sns/jscode2session') {
      if (query['appid'] !== MINI_APP_ID || query['secret'] !== MINI_APP_SECRET) {
        json(res, { errcode: 40013, errmsg: 'invalid appid' });
        return;
      }
      const jsCode = query['js_code'] ?? '';
      let session = miniSessions.get(jsCode);
      if (!session && !spentCodes.has(`login:${jsCode}`)) {
        const openid = deviceIdentity(deviceMode, 'login', jsCode);
        if (openid !== null) session = { openid };
      }
      if (!session) {
        json(
          res,
          spentCodes.has(`login:${jsCode}`)
            ? { errcode: 40163, errmsg: 'code been used' }
            : { errcode: 40029, errmsg: 'invalid code' },
        );
        return;
      }
      miniSessions.delete(jsCode);
      spentCodes.add(`login:${jsCode}`);
      json(res, {
        openid: session.openid,
        ...(session.unionid === undefined ? {} : { unionid: session.unionid }),
        session_key: session.sessionKey ?? 'FAKE_SESSION_KEY',
      });
      return;
    }

    const canned = behaviour.failNext;
    if (canned) {
      behaviour.failNext = null;
      json(res, canned);
      return;
    }

    // Every endpoint below needs a token WeChat issued; the client is the only
    // thing that knows how to get one, so an absent one is a real failure.
    if (query['access_token'] === undefined || !tokens.includes(query['access_token'])) {
      json(res, { errcode: 40001, errmsg: 'invalid credential' });
      return;
    }

    const body = (parsed ?? {}) as Record<string, unknown>;
    const app = tokenApp.get(query['access_token'] ?? '') ?? 'oa';

    // The mini-program endpoints. A token minted from the OA's credentials is
    // refused here exactly as WeChat refuses it: the two apps are two apps.
    if (url.pathname.startsWith('/wxa/')) {
      if (app !== 'mini') {
        json(res, { errcode: 40013, errmsg: 'invalid appid' });
        return;
      }
      switch (url.pathname) {
        case '/wxa/business/getuserphonenumber': {
          const phoneCode = String(body['code'] ?? '');
          let found = phoneCodes.get(phoneCode);
          if (!found && !spentCodes.has(`phone:${phoneCode}`)) {
            const phone = deviceIdentity(deviceMode, 'phone', phoneCode);
            if (phone !== null) found = { phone };
          }
          if (!found) {
            json(
              res,
              spentCodes.has(`phone:${phoneCode}`)
                ? { errcode: 40163, errmsg: 'code been used' }
                : { errcode: 40029, errmsg: 'invalid code' },
            );
            return;
          }
          phoneCodes.delete(phoneCode);
          spentCodes.add(`phone:${phoneCode}`);
          json(res, {
            errcode: 0,
            errmsg: 'ok',
            phone_info: {
              phoneNumber: `+${found.countryCode ?? '86'}${found.phone}`,
              purePhoneNumber: found.phone,
              countryCode: found.countryCode ?? '86',
            },
          });
          return;
        }
        case '/wxa/getwxacodeunlimit': {
          if (behaviour.failWxaCode) {
            json(res, behaviour.failWxaCode);
            return;
          }
          const scene = String(body['scene'] ?? '');
          if (scene === '' || Buffer.byteLength(scene, 'utf8') > SCENE_MAX_BYTES) {
            json(res, { errcode: 40097, errmsg: 'invalid args' });
            return;
          }
          const envVersion = body['env_version'] ?? 'release';
          if (envVersion !== 'release' && envVersion !== 'trial' && envVersion !== 'develop') {
            json(res, { errcode: 40097, errmsg: 'invalid args: env_version' });
            return;
          }
          miniCodes.push({ page: String(body['page'] ?? ''), scene });
          png(res);
          return;
        }
        case '/wxa/sec/order/upload_shipping_info':
          json(res, uploadShipping(body));
          return;
        case '/wxa/sec/order/get_order': {
          const key =
            body['transaction_id'] !== undefined
              ? `tx:${String(body['transaction_id'])}`
              : `mch:${String(body['merchant_id'] ?? '')}:${String(body['merchant_trade_no'] ?? '')}`;
          const order = tradeOrders.get(key);
          if (!order) {
            json(res, { errcode: 10060001, errmsg: '支付单不存在' });
            return;
          }
          json(res, {
            errcode: 0,
            errmsg: 'ok',
            order: {
              order_state: order.orderState,
              ...(key.startsWith('tx:') ? { transaction_id: key.slice(3) } : {}),
              shipping: { delivery_mode: order.uploads.at(-1)?.['delivery_mode'] ?? null },
            },
          });
          return;
        }
        case '/wxa/sec/order/set_msg_jump_path': {
          const path = String(body['path'] ?? '');
          if (path === '') {
            json(res, { errcode: 47001, errmsg: 'data format error: path' });
            return;
          }
          msgJumpPath = path;
          json(res, { errcode: 0, errmsg: 'ok' });
          return;
        }
        case '/wxa/msg_sec_check': {
          if (behaviour.failSecCheck) {
            json(res, behaviour.failSecCheck);
            return;
          }
          const openid = String(body['openid'] ?? '');
          const content = String(body['content'] ?? '');
          if (body['version'] !== 2 || openid === '' || content === '') {
            json(res, { errcode: openid === '' ? 40003 : 47001, errmsg: 'invalid args' });
            return;
          }
          const verdict = behaviour.secCheckRiskyWords.some((word) => content.includes(word))
            ? { suggest: 'risky', label: 20002 }
            : behaviour.secCheckReviewWords.some((word) => content.includes(word))
              ? { suggest: 'review', label: 21000 }
              : { suggest: 'pass', label: 100 };
          traceSeq += 1;
          json(res, {
            errcode: 0,
            errmsg: 'ok',
            result: verdict,
            detail: [{ strategy: 'content_model', errcode: 0, ...verdict, prob: 90 }],
            trace_id: `fake-msg-${traceRun}-${traceSeq}`,
          });
          return;
        }
        case '/wxa/media_check_async': {
          if (behaviour.failMediaCheck) {
            json(res, behaviour.failMediaCheck);
            return;
          }
          const openid = String(body['openid'] ?? '');
          const mediaUrl = String(body['media_url'] ?? '');
          if (
            body['version'] !== 2 ||
            openid === '' ||
            !/^https?:\/\//.test(mediaUrl) ||
            (body['media_type'] !== 1 && body['media_type'] !== 2)
          ) {
            json(res, { errcode: openid === '' ? 40003 : 47001, errmsg: 'invalid args' });
            return;
          }
          traceSeq += 1;
          const traceId = `fake-media-${traceRun}-${traceSeq}`;
          mediaChecks.push({ traceId, mediaUrl, openid, scene: Number(body['scene'] ?? 0) });
          json(res, { errcode: 0, errmsg: 'ok', trace_id: traceId });
          return;
        }
        case '/wxa/sec/order/is_trade_managed': {
          if (body['appid'] !== MINI_APP_ID) {
            json(res, { errcode: 40013, errmsg: 'invalid appid' });
            return;
          }
          json(res, { errcode: 0, errmsg: 'ok', is_trade_managed: behaviour.tradeManaged });
          return;
        }
        default:
          json(res, { errcode: 48001, errmsg: `fake oa: ${url.pathname} 未实现` });
          return;
      }
    }

    switch (url.pathname) {
      // The two message endpoints the notification channels call. Each app may
      // only send its own kind: a template message goes out under the OA's
      // token, a subscribe message under the mini-program's.
      case '/cgi-bin/message/template/send': {
        if (app !== 'oa') {
          json(res, { errcode: 40013, errmsg: 'invalid appid' });
          return;
        }
        messageSeq += 1;
        json(res, { errcode: 0, errmsg: 'ok', msgid: messageSeq });
        return;
      }
      case '/cgi-bin/message/subscribe/send': {
        if (app !== 'mini') {
          json(res, { errcode: 40013, errmsg: 'invalid appid' });
          return;
        }
        json(res, { errcode: 0, errmsg: 'ok' });
        return;
      }
      case '/cgi-bin/menu/create': {
        if (behaviour.failMenu) {
          json(res, behaviour.failMenu);
          return;
        }
        publishedMenu = body['button'] ?? null;
        json(res, { errcode: 0, errmsg: 'ok' });
        return;
      }
      case '/cgi-bin/menu/delete': {
        publishedMenu = null;
        json(res, { errcode: 0, errmsg: 'ok' });
        return;
      }
      case '/cgi-bin/qrcode/create': {
        const info = body['action_info'] as { scene?: { scene_str?: string } } | undefined;
        const scene = info?.scene?.scene_str ?? '';
        scenes.push(scene);
        json(res, {
          ticket: `TICKET_${scene}`,
          expire_seconds: Number(body['expire_seconds'] ?? 0),
          url: `https://weixin.qq.com/q/${scene}`,
        });
        return;
      }
      case '/cgi-bin/ticket/getticket': {
        json(res, {
          errcode: 0,
          errmsg: 'ok',
          ticket: `JSAPI_TICKET_${issued}`,
          expires_in: behaviour.ticketExpiresIn,
        });
        return;
      }
      case '/cgi-bin/media/upload':
      case '/cgi-bin/material/add_material': {
        mediaSequence += 1;
        const permanent = url.pathname.endsWith('add_material');
        const mediaId = `${permanent ? 'PERM' : 'TEMP'}_MEDIA_${mediaSequence}`;
        const kind = (query['type'] ?? 'image') as FakeOaMaterial['kind'];
        const mediaUrl = permanent ? `https://mmbiz.qpic.cn/${mediaId}` : null;
        if (permanent) {
          material.set(mediaId, { mediaId, kind, url: mediaUrl, updateTime: 1_767_668_400 });
        }
        json(res, { media_id: mediaId, ...(mediaUrl === null ? {} : { url: mediaUrl }) });
        return;
      }
      case '/cgi-bin/material/del_material': {
        const mediaId = String(body['media_id'] ?? '');
        if (!material.delete(mediaId)) {
          // WeChat's own answer for a handle it has already forgotten, which the
          // service treats as a correction rather than a failure.
          json(res, { errcode: 40007, errmsg: 'invalid media_id' });
          return;
        }
        json(res, { errcode: 0, errmsg: 'ok' });
        return;
      }
      case '/cgi-bin/material/batchget_material': {
        const kind = String(body['type'] ?? 'image');
        const offset = Number(body['offset'] ?? 0);
        const count = Number(body['count'] ?? 20);
        const all = [...material.values()].filter((item) => item.kind === kind);
        json(res, {
          total_count: all.length,
          item_count: Math.min(count, Math.max(all.length - offset, 0)),
          item: all.slice(offset, offset + count).map((item) => ({
            media_id: item.mediaId,
            url: item.url ?? '',
            update_time: item.updateTime,
          })),
        });
        return;
      }
      default:
        json(res, { errcode: 48001, errmsg: `fake oa: ${url.pathname} 未实现` });
    }
  }

  return {
    url: `http://127.0.0.1:${port}`,
    appId: APP_ID,
    appSecret: APP_SECRET,
    miniAppId: MINI_APP_ID,
    miniAppSecret: MINI_APP_SECRET,
    deviceMode,
    calls,
    material,
    scenes,
    miniCodes,
    behaviour,
    tokens,
    server,
    get publishedMenu() {
      return publishedMenu;
    },
    addMaterial(item) {
      material.set(item.mediaId, { updateTime: 1_767_668_400, ...item });
    },
    setMiniCode(code, session) {
      miniSessions.set(code, session);
    },
    setPhoneCode(code, phone) {
      phoneCodes.set(code, phone);
    },
    tradeOrders,
    tradeOrder(transactionId) {
      return tradeOrders.get(`tx:${transactionId}`);
    },
    setTradeOrderState(transactionId, orderState) {
      const key = `tx:${transactionId}`;
      const order = tradeOrders.get(key) ?? {
        orderState,
        uploads: [],
        allDelivered: false,
        corrected: false,
      };
      order.orderState = orderState;
      tradeOrders.set(key, order);
    },
    get msgJumpPath() {
      return msgJumpPath;
    },
    mediaChecks,
    mediaCheckPush(traceId, suggest, options = {}) {
      const check = mediaChecks.find((item) => item.traceId === traceId);
      const label =
        options.label ?? (suggest === 'risky' ? 20002 : suggest === 'review' ? 21000 : 100);
      return {
        ToUserName: 'gh_fakemini00001',
        FromUserName: check?.openid ?? '',
        CreateTime: options.createTime ?? Math.floor(Date.now() / 1000),
        MsgType: 'event',
        Event: 'wxa_media_check',
        appid: MINI_APP_ID,
        trace_id: traceId,
        version: 2,
        detail: [{ strategy: 'content_model', errcode: 0, suggest, label, prob: 90 }],
        errcode: 0,
        errmsg: 'ok',
        result: { suggest, label },
      };
    },
    callsTo(path) {
      return calls.filter((call) => call.path === path);
    },
    reset() {
      calls.length = 0;
      material.clear();
      scenes.length = 0;
      miniCodes.length = 0;
      miniSessions.clear();
      phoneCodes.clear();
      spentCodes.clear();
      publishedMenu = null;
      behaviour.failNext = null;
      behaviour.failMenu = null;
      behaviour.ticketExpiresIn = 7200;
      behaviour.dropNext = false;
      behaviour.failWxaCode = null;
      behaviour.failShipping = null;
      behaviour.tradeManaged = true;
      behaviour.secCheckRiskyWords = [...DEFAULT_RISKY_WORDS];
      behaviour.secCheckReviewWords = [...DEFAULT_REVIEW_WORDS];
      behaviour.failSecCheck = null;
      behaviour.failMediaCheck = null;
      mediaChecks.length = 0;
      tradeOrders.clear();
      msgJumpPath = null;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** Two uploads describe the same shipping when all but `upload_time` match. */
function sameShipping(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const strip = ({ upload_time: _ignored, ...rest }: Record<string, unknown>) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}
