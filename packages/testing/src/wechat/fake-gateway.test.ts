import { createDecipheriv, createSign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  encryptResource,
  generateFakeWechatKeys,
  signatureMessage,
  signWithKey,
  startFakeWechatGateway,
  verifyWithKey,
  type FakeWechatGateway,
} from './fake-gateway';

/**
 * The *crypto plumbing* has to be real: a fake that signs incorrectly would
 * teach the client's verifier to be wrong too. So does the *rule* plumbing —
 * the payment races are gateway races, and a gateway that says yes to
 * everything cannot express them.
 */

let gateway: FakeWechatGateway;

beforeAll(async () => {
  gateway = await startFakeWechatGateway();
});

afterAll(async () => {
  await gateway?.close();
});

async function createTransaction(outTradeNo: string, total = 1990): Promise<Response> {
  return fetch(`${gateway.url}/v3/pay/transactions/jsapi`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      appid: gateway.keys.appId,
      mchid: gateway.keys.mchId,
      out_trade_no: outTradeNo,
      amount: { total, currency: 'CNY' },
      payer: { openid: 'oTestOpenid' },
    }),
  });
}

describe('signature primitives', () => {
  it('signs and verifies the documented message', () => {
    const keys = generateFakeWechatKeys();
    const message = signatureMessage('1700000000', 'abc', '{"a":1}');
    expect(message).toBe('1700000000\nabc\n{"a":1}\n');

    const signature = signWithKey(keys.platformPrivateKeyPem, message);
    expect(verifyWithKey(keys.platformPublicKeyPem, message, signature)).toBe(true);
    expect(verifyWithKey(keys.platformPublicKeyPem, `${message}tampered`, signature)).toBe(false);
  });

  it('encrypts a resource the way v3 notifications do', () => {
    const keys = generateFakeWechatKeys();
    const resource = encryptResource(keys.apiV3Key, '{"trade_state":"SUCCESS"}', 'transaction');
    expect(resource.algorithm).toBe('AEAD_AES_256_GCM');
    expect(resource.associated_data).toBe('transaction');

    // Decrypt exactly as the real client must.
    const raw = Buffer.from(resource.ciphertext, 'base64');
    const tag = raw.subarray(raw.length - 16);
    const data = raw.subarray(0, raw.length - 16);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(keys.apiV3Key, 'utf8'),
      Buffer.from(resource.nonce),
    );
    decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    expect(JSON.parse(plaintext)).toEqual({ trade_state: 'SUCCESS' });
  });

  it('uses a 32-byte APIv3 key, as AES-256 requires', () => {
    expect(Buffer.byteLength(generateFakeWechatKeys().apiV3Key, 'utf8')).toBe(32);
  });
});

describe('the endpoints', () => {
  it('creates a transaction and returns a prepay_id', async () => {
    const response = await createTransaction('T1');
    expect(response.status).toBe(200);
    expect((await response.json()).prepay_id).toMatch(/^wx[0-9a-f]{32}$/);
    expect(gateway.transactions.get('T1')).toMatchObject({
      amountFen: 1990,
      tradeState: 'NOTPAY',
    });
  });

  it('signs its own responses', async () => {
    const response = await createTransaction('T-signed');
    const timestamp = response.headers.get('wechatpay-timestamp')!;
    const nonce = response.headers.get('wechatpay-nonce')!;
    const signature = response.headers.get('wechatpay-signature')!;
    expect(response.headers.get('wechatpay-serial')).toBe(gateway.keys.platformSerial);

    const payload = JSON.stringify(await response.json());
    expect(
      verifyWithKey(
        gateway.keys.platformPublicKeyPem,
        signatureMessage(timestamp, nonce, payload),
        signature,
      ),
    ).toBe(true);
  });

  it('queries a transaction by out_trade_no', async () => {
    await createTransaction('T2');
    const response = await fetch(`${gateway.url}/v3/pay/transactions/out-trade-no/T2`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ out_trade_no: 'T2', trade_state: 'NOTPAY' });
    expect(payload.amount.total).toBe(1990);
  });

  it('404s an unknown out_trade_no with a WeChat-shaped error', async () => {
    const response = await fetch(`${gateway.url}/v3/pay/transactions/out-trade-no/nope`);
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('ORDER_NOT_EXIST');
  });

  it('closes an unpaid transaction with 204', async () => {
    await createTransaction('T3');
    const response = await fetch(`${gateway.url}/v3/pay/transactions/out-trade-no/T3/close`, {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(204);
    expect(gateway.transactions.get('T3')?.tradeState).toBe('CLOSED');
  });

  it('accepts a refund', async () => {
    await createTransaction('T4');
    gateway.markPaid('T4');
    const response = await fetch(`${gateway.url}/v3/refund/domestic/refunds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ out_trade_no: 'T4', out_refund_no: 'R4', amount: { refund: 1990 } }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ out_refund_no: 'R4', status: 'PROCESSING' });
    expect(gateway.transactions.get('T4')?.tradeState).toBe('REFUND');
  });

  it('records every call so a test can assert what the client sent', async () => {
    const before = gateway.calls.length;
    await createTransaction('T5');
    const call = gateway.calls[before]!;
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/v3/pay/transactions/jsapi');
    expect((call.body as { out_trade_no: string }).out_trade_no).toBe('T5');
  });

  it('verifies the Authorization signature when the client sends one', async () => {
    const body = JSON.stringify({ out_trade_no: 'T6', amount: { total: 100 } });
    const timestamp = '1700000000';
    const nonce = 'abcdef';
    const url = '/v3/pay/transactions/jsapi';
    const message = `POST\n${url}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature = createSign('RSA-SHA256')
      .update(message)
      .sign(gateway.keys.merchantPrivateKeyPem, 'base64');

    const before = gateway.calls.length;
    await fetch(`${gateway.url}${url}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization:
          `WECHATPAY2-SHA256-RSA2048 mchid="${gateway.keys.mchId}",` +
          `nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",` +
          `serial_no="${gateway.keys.merchantSerial}"`,
      },
      body,
    });
    expect(gateway.calls[before]?.signatureValid).toBe(true);
  });

  it('flags a bad Authorization signature', async () => {
    const before = gateway.calls.length;
    await fetch(`${gateway.url}/v3/pay/transactions/jsapi`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization:
          'WECHATPAY2-SHA256-RSA2048 mchid="x",nonce_str="n",signature="bm90LWEtc2ln",timestamp="1"',
      },
      body: JSON.stringify({ out_trade_no: 'T7' }),
    });
    expect(gateway.calls[before]?.signatureValid).toBe(false);
  });

  it('reports an unimplemented endpoint clearly rather than hanging', async () => {
    const response = await fetch(`${gateway.url}/v3/pay/transactions/id/12345`);
    expect(response.status).toBe(404);
    expect((await response.json()).message).toContain('未实现');
  });
});

describe('each create endpoint answers in its own shape', () => {
  const createOn = (tradeType: string, outTradeNo: string, total = 1990) =>
    fetch(`${gateway.url}/v3/pay/transactions/${tradeType}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appid: gateway.keys.appId,
        mchid: gateway.keys.mchId,
        out_trade_no: outTradeNo,
        amount: { total, currency: 'CNY' },
        ...(tradeType === 'jsapi' ? { payer: { openid: 'oTestOpenid' } } : {}),
      }),
    });

  /** The body, after checking the platform signature over exactly those bytes. */
  async function signedBody(response: Response): Promise<Record<string, unknown>> {
    const raw = await response.text();
    const ok = verifyWithKey(
      gateway.keys.platformPublicKeyPem,
      signatureMessage(
        response.headers.get('wechatpay-timestamp')!,
        response.headers.get('wechatpay-nonce')!,
        raw,
      ),
      response.headers.get('wechatpay-signature')!,
    );
    expect(ok).toBe(true);
    return JSON.parse(raw) as Record<string, unknown>;
  }

  const SHAPES = {
    jsapi: { key: 'prepay_id', pattern: /^wx[0-9a-f]{32}$/ },
    app: { key: 'prepay_id', pattern: /^wx[0-9a-f]{32}$/ },
    native: { key: 'code_url', pattern: /^weixin:\/\/wxpay\/bizpayurl\?pr=[0-9a-f]+$/ },
    h5: { key: 'h5_url', pattern: /^http:\/\/127\.0\.0\.1:\d+\/h5-cashier\?out_trade_no=/ },
  } as const;

  for (const [tradeType, { key, pattern }] of Object.entries(SHAPES)) {
    it(`${tradeType}: a fresh create answers a signed { ${key} } and nothing else`, async () => {
      const response = await createOn(tradeType, `S-${tradeType}-1`);
      expect(response.status).toBe(200);
      const body = await signedBody(response);
      expect(Object.keys(body)).toEqual([key]);
      expect(body[key]).toMatch(pattern);
      expect(gateway.transactions.get(`S-${tradeType}-1`)).toMatchObject({ tradeState: 'NOTPAY' });
    });

    it(`${tradeType}: a repeat create of the same unpaid order answers { ${key} } again`, async () => {
      const first = await signedBody(await createOn(tradeType, `S-${tradeType}-2`));
      const again = await signedBody(await createOn(tradeType, `S-${tradeType}-2`));
      expect(Object.keys(again)).toEqual([key]);
      expect(again[key]).toMatch(pattern);
      expect(again[key]).not.toBe(first[key]);
    });
  }

  it('maps every prepay_id it answers back to its order, as a bare id or a package', async () => {
    const first = await signedBody(await createOn('jsapi', 'S-prepay-1'));
    const again = await signedBody(await createOn('jsapi', 'S-prepay-1'));
    const other = await signedBody(await createOn('jsapi', 'S-prepay-2'));

    expect(gateway.transactionForPrepay(String(first.prepay_id))?.outTradeNo).toBe('S-prepay-1');
    expect(gateway.transactionForPrepay(`prepay_id=${String(again.prepay_id)}`)?.outTradeNo).toBe(
      'S-prepay-1',
    );
    expect(gateway.transactionForPrepay(String(other.prepay_id))?.outTradeNo).toBe('S-prepay-2');
    expect(gateway.transactionForPrepay('prepay_id=wx-never-issued')).toBeUndefined();
  });

  it('h5: the h5_url names the order and is the fake`s own cashier page', async () => {
    const body = await signedBody(await createOn('h5', 'S-h5-url'));
    const url = new URL(String(body.h5_url));
    expect(`${url.origin}${url.pathname}`).toBe(gateway.h5CashierUrl);
    expect(url.searchParams.get('out_trade_no')).toBe('S-h5-url');
  });

  describe('the fake H5 cashier', () => {
    it('sends the browser back to the redirect_url the app appended, and settles nothing', async () => {
      const body = await signedBody(await createOn('h5', 'S-h5-back'));
      const back = 'http://127.0.0.1:3000/pages/goods/order_pay_status/index?order_id=9';
      const callsBefore = gateway.calls.length;
      const response = await fetch(`${body.h5_url}&redirect_url=${encodeURIComponent(back)}`, {
        redirect: 'manual',
      });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(back);
      // Paying stays the test's job.
      expect(gateway.transactions.get('S-h5-back')!.tradeState).toBe('NOTPAY');
      // A browser visit, not an API call from the app.
      expect(gateway.calls.length).toBe(callsBefore);
    });

    it('answers a plain 200 without a redirect_url, or with one that is not http(s)', async () => {
      const plain = await fetch(`${gateway.h5CashierUrl}?out_trade_no=X`, { redirect: 'manual' });
      expect(plain.status).toBe(200);
      expect(await plain.text()).toBe('fake cashier');
      const odd = await fetch(
        `${gateway.h5CashierUrl}?out_trade_no=X&redirect_url=${encodeURIComponent('javascript:alert(1)')}`,
        { redirect: 'manual' },
      );
      expect(odd.status).toBe(200);
    });

    it('can point h5_url somewhere else', async () => {
      const elsewhere = await startFakeWechatGateway({
        keys: gateway.keys,
        h5CashierUrl: 'https://cashier.example.test/pay',
      });
      try {
        expect(elsewhere.h5CashierUrl).toBe('https://cashier.example.test/pay');
        const response = await fetch(`${elsewhere.url}/v3/pay/transactions/h5`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ out_trade_no: 'S-else', amount: { total: 1 } }),
        });
        const body = (await response.json()) as { h5_url: string };
        expect(body.h5_url.startsWith('https://cashier.example.test/pay?out_trade_no=S-else')).toBe(
          true,
        );
      } finally {
        await elsewhere.close();
      }
    });
  });
});

describe('postNotify', () => {
  let app: Server;
  let notifyUrl: string;
  const received: Array<{ headers: Record<string, string>; body: string }> = [];

  beforeAll(async () => {
    app = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k, String(v ?? '')]),
          ),
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'SUCCESS' }));
      });
    });
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    notifyUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/v1/payment/notify`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => app.close(() => resolve()));
  });

  it('delivers a correctly signed, correctly encrypted callback', async () => {
    await createTransaction('N1', 500);
    gateway.markPaid('N1');

    const result = await gateway.postNotify(notifyUrl, { outTradeNo: 'N1' });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ code: 'SUCCESS' });

    const delivered = received.at(-1)!;
    const { headers, body } = delivered;

    // The signature the app's verifier has to check.
    expect(
      verifyWithKey(
        gateway.keys.platformPublicKeyPem,
        signatureMessage(headers['wechatpay-timestamp']!, headers['wechatpay-nonce']!, body),
        headers['wechatpay-signature']!,
      ),
    ).toBe(true);
    expect(headers['wechatpay-serial']).toBe(gateway.keys.platformSerial);

    const notification = JSON.parse(body);
    expect(notification.event_type).toBe('TRANSACTION.SUCCESS');
    expect(notification.resource.algorithm).toBe('AEAD_AES_256_GCM');

    const raw = Buffer.from(notification.resource.ciphertext, 'base64');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(gateway.keys.apiV3Key, 'utf8'),
      Buffer.from(notification.resource.nonce),
    );
    decipher.setAAD(Buffer.from(notification.resource.associated_data, 'utf8'));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const plaintext = JSON.parse(
      Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString(
        'utf8',
      ),
    );
    expect(plaintext).toMatchObject({ out_trade_no: 'N1', trade_state: 'SUCCESS' });
    expect(plaintext.amount.total).toBe(500);
  });

  it('can deliver the same callback twice, for the duplicate-notify test C needs', async () => {
    await createTransaction('N2', 100);
    gateway.markPaid('N2');
    const first = await gateway.postNotify(notifyUrl, { outTradeNo: 'N2' });
    const second = await gateway.postNotify(notifyUrl, { outTradeNo: 'N2' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('refuses to notify about a transaction it never created', async () => {
    await expect(gateway.postNotify(notifyUrl, { outTradeNo: 'nope' })).rejects.toThrow('未知交易');
  });
});

/**
 * The business rules. A separate instance with its own clock, because these
 * tests mutate `behaviour` and drive expiry, and neither should leak into the
 * crypto tests above.
 */
describe('the rules that make the races testable', () => {
  let rules: FakeWechatGateway;
  let clockMs: number;

  beforeAll(async () => {
    clockMs = Date.parse('2026-01-01T00:00:00Z');
    rules = await startFakeWechatGateway({ now: () => clockMs });
  });

  afterAll(async () => {
    await rules?.close();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${rules.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const create = (outTradeNo: string, total = 1000, extra: Record<string, unknown> = {}) =>
    post('/v3/pay/transactions/jsapi', {
      appid: rules.keys.appId,
      mchid: rules.keys.mchId,
      out_trade_no: outTradeNo,
      amount: { total, currency: 'CNY' },
      payer: { openid: 'oTestOpenid' },
      ...extra,
    });

  const refund = (body: Record<string, unknown>) => post('/v3/refund/domestic/refunds', body);

  async function codeOf(response: Response): Promise<string> {
    return (await response.json()).code;
  }

  describe('creating a transaction', () => {
    it('refuses a second create once the money has arrived', async () => {
      await create('R-paid');
      rules.markPaid('R-paid');
      const response = await create('R-paid');
      expect(response.status).toBe(400);
      expect(await codeOf(response)).toBe('ORDERPAID');
    });

    it('refuses a create on a closed order', async () => {
      await create('R-closed');
      await post('/v3/pay/transactions/out-trade-no/R-closed/close', {});
      const response = await create('R-closed');
      expect(await codeOf(response)).toBe('ORDER_CLOSED');
    });

    it('hands out a fresh prepay_id for an unchanged, unpaid order', async () => {
      const first = await (await create('R-again')).json();
      const second = await (await create('R-again')).json();
      expect(second.prepay_id).toMatch(/^wx[0-9a-f]{32}$/);
      expect(second.prepay_id).not.toBe(first.prepay_id);
    });

    it('refuses to reprice an order that is already collectible', async () => {
      await create('R-repriced', 1000);
      const response = await create('R-repriced', 2000);
      expect(await codeOf(response)).toBe('INVALID_REQUEST');
    });

    it('checks the merchant and app identity it was sent', async () => {
      const wrongMch = await post('/v3/pay/transactions/jsapi', {
        appid: rules.keys.appId,
        mchid: '1900000999',
        out_trade_no: 'R-mch',
        amount: { total: 1 },
      });
      expect(await codeOf(wrongMch)).toBe('PARAM_ERROR');

      const wrongApp = await post('/v3/pay/transactions/jsapi', {
        appid: 'wxdeadbeef',
        mchid: rules.keys.mchId,
        out_trade_no: 'R-app',
        amount: { total: 1 },
      });
      expect(await codeOf(wrongApp)).toBe('APPID_MCHID_NOT_MATCH');
    });

    it('honours time_expire, so an unpaid order closes itself', async () => {
      await create('R-expiring', 1000, {
        time_expire: new Date(clockMs + 60_000).toISOString(),
      });
      const before = await (
        await fetch(`${rules.url}/v3/pay/transactions/out-trade-no/R-expiring`)
      ).json();
      expect(before.trade_state).toBe('NOTPAY');

      clockMs += 61_000;
      const after = await (
        await fetch(`${rules.url}/v3/pay/transactions/out-trade-no/R-expiring`)
      ).json();
      expect(after.trade_state).toBe('CLOSED');
      clockMs -= 61_000;
    });

    it('expires on demand, for a test that would rather not move time', async () => {
      await create('R-expire-now');
      expect(rules.expireTransaction('R-expire-now').tradeState).toBe('CLOSED');
    });
  });

  describe('closing', () => {
    it('refuses to close a paid transaction — the cancel-vs-callback race', async () => {
      await create('R-close-paid');
      rules.markPaid('R-close-paid');
      const response = await post('/v3/pay/transactions/out-trade-no/R-close-paid/close', {});
      expect(response.status).toBe(400);
      expect(await codeOf(response)).toBe('ORDERPAID');
      expect(rules.transactions.get('R-close-paid')?.tradeState).toBe('SUCCESS');
    });

    it('is retryable: closing twice still answers 204', async () => {
      await create('R-close-twice');
      expect((await post('/v3/pay/transactions/out-trade-no/R-close-twice/close', {})).status).toBe(
        204,
      );
      expect((await post('/v3/pay/transactions/out-trade-no/R-close-twice/close', {})).status).toBe(
        204,
      );
    });

    it('404s a close of an order it never saw', async () => {
      const response = await post('/v3/pay/transactions/out-trade-no/R-never/close', {});
      expect(response.status).toBe(404);
      expect(await codeOf(response)).toBe('ORDER_NOT_EXIST');
    });
  });

  describe('refunding', () => {
    beforeAll(async () => {
      await create('R-src', 1000);
      rules.markPaid('R-src');
    });

    it('refuses to refund an order that was never paid', async () => {
      await create('R-unpaid', 500);
      const response = await refund({
        out_trade_no: 'R-unpaid',
        out_refund_no: 'RF-unpaid',
        amount: { refund: 500, total: 500 },
      });
      expect(response.status).toBe(403);
      expect(await codeOf(response)).toBe('TRADE_ERROR');
    });

    it('checks the total the app claims the original collected', async () => {
      const response = await refund({
        out_trade_no: 'R-src',
        out_refund_no: 'RF-wrong-total',
        amount: { refund: 100, total: 9999 },
      });
      expect(await codeOf(response)).toBe('PARAM_ERROR');
    });

    it('accumulates partial refunds and caps them at the total', async () => {
      const first = await refund({
        out_trade_no: 'R-src',
        out_refund_no: 'RF-1',
        amount: { refund: 400, total: 1000 },
      });
      expect(first.status).toBe(200);
      expect(rules.transactions.get('R-src')?.refundedFen).toBe(400);

      const second = await refund({
        out_trade_no: 'R-src',
        out_refund_no: 'RF-2',
        amount: { refund: 700, total: 1000 },
      });
      expect(second.status).toBe(403);
      expect(await codeOf(second)).toBe('REFUND_FEE_MISMATCH');
      expect(rules.transactions.get('R-src')?.refundedFen).toBe(400);
    });

    it('is idempotent by merchant refund number, and rejects a changed amount', async () => {
      const again = await refund({
        out_trade_no: 'R-src',
        out_refund_no: 'RF-1',
        amount: { refund: 400, total: 1000 },
      });
      expect(again.status).toBe(200);
      expect((await again.json()).refund_id).toBe(rules.refunds.get('RF-1')?.refundId);
      expect(rules.transactions.get('R-src')?.refundedFen).toBe(400);

      const changed = await refund({
        out_trade_no: 'R-src',
        out_refund_no: 'RF-1',
        amount: { refund: 401, total: 1000 },
      });
      expect(await codeOf(changed)).toBe('INVALID_REQUEST');
    });

    it('reports NOT_ENOUGH when the merchant balance is short', async () => {
      await create('R-balance', 1000);
      rules.markPaid('R-balance');
      rules.behaviour.refundBalanceFen = 100;
      try {
        const response = await refund({
          out_trade_no: 'R-balance',
          out_refund_no: 'RF-balance',
          amount: { refund: 1000, total: 1000 },
        });
        expect(response.status).toBe(403);
        expect(await codeOf(response)).toBe('NOT_ENOUGH');
        expect(rules.transactions.get('R-balance')?.refundedFen).toBe(0);
      } finally {
        rules.behaviour.refundBalanceFen = null;
      }
    });

    it('answers a query by merchant refund number, and 404s an unknown one', async () => {
      const found = await fetch(`${rules.url}/v3/refund/domestic/refunds/RF-1`);
      expect(found.status).toBe(200);
      expect(await found.json()).toMatchObject({
        out_refund_no: 'RF-1',
        out_trade_no: 'R-src',
        status: 'PROCESSING',
      });

      const missing = await fetch(`${rules.url}/v3/refund/domestic/refunds/RF-nope`);
      expect(missing.status).toBe(404);
      expect(await codeOf(missing)).toBe('RESOURCE_NOT_EXISTS');
    });

    it('gives the money back when a refund is closed rather than settled', async () => {
      await create('R-closed-refund', 300);
      rules.markPaid('R-closed-refund');
      await refund({
        out_trade_no: 'R-closed-refund',
        out_refund_no: 'RF-closed',
        amount: { refund: 300, total: 300 },
      });
      expect(rules.transactions.get('R-closed-refund')?.refundedFen).toBe(300);
      rules.markRefunded('RF-closed', 'CLOSED');
      expect(rules.transactions.get('R-closed-refund')?.refundedFen).toBe(0);
    });
  });

  describe('failure injection', () => {
    it('serves one canned error and then goes back to normal', async () => {
      rules.behaviour.failNext = { status: 500, code: 'SYSTEM_ERROR', message: '系统繁忙' };
      const failed = await create('R-canned');
      expect(failed.status).toBe(500);
      expect(await codeOf(failed)).toBe('SYSTEM_ERROR');
      expect(rules.transactions.has('R-canned')).toBe(false);

      expect((await create('R-canned')).status).toBe(200);
    });

    it('drops one connection, which the client sees as a transport failure', async () => {
      rules.behaviour.dropNext = true;
      await expect(create('R-dropped')).rejects.toThrow();
      expect(rules.behaviour.dropNext).toBe(false);
      expect((await create('R-dropped')).status).toBe(200);
    });

    it('can sign with a key the client does not trust', async () => {
      rules.behaviour.signResponsesWithWrongKey = true;
      try {
        const response = await create('R-untrusted');
        const payload = JSON.stringify(await response.json());
        expect(
          verifyWithKey(
            rules.keys.platformPublicKeyPem,
            signatureMessage(
              response.headers.get('wechatpay-timestamp')!,
              response.headers.get('wechatpay-nonce')!,
              payload,
            ),
            response.headers.get('wechatpay-signature')!,
          ),
        ).toBe(false);
      } finally {
        rules.behaviour.signResponsesWithWrongKey = false;
      }
    });
  });

  describe('refund notifications', () => {
    let app: Server;
    let notifyUrl: string;
    const received: Array<{ headers: Record<string, string>; body: string }> = [];

    beforeAll(async () => {
      app = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          received.push({
            headers: Object.fromEntries(
              Object.entries(req.headers).map(([k, v]) => [k, String(v ?? '')]),
            ),
            body: Buffer.concat(chunks).toString('utf8'),
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 'SUCCESS' }));
        });
      });
      await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
      notifyUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/v1/webhooks/wechat-refund`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => app.close(() => resolve()));
    });

    function decrypt(body: string): { envelope: Record<string, unknown>; plaintext: unknown } {
      const envelope = JSON.parse(body);
      const resource = envelope.resource;
      const raw = Buffer.from(resource.ciphertext, 'base64');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(rules.keys.apiV3Key, 'utf8'),
        Buffer.from(resource.nonce),
      );
      decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      return {
        envelope,
        plaintext: JSON.parse(
          Buffer.concat([
            decipher.update(raw.subarray(0, raw.length - 16)),
            decipher.final(),
          ]).toString('utf8'),
        ),
      };
    }

    it('delivers a signed REFUND.SUCCESS with refund associated_data', async () => {
      await create('N-refund', 800);
      rules.markPaid('N-refund');
      await refund({
        out_trade_no: 'N-refund',
        out_refund_no: 'RF-notify',
        amount: { refund: 800, total: 800 },
      });
      rules.markRefunded('RF-notify');

      const result = await rules.postRefundNotify(notifyUrl, { outRefundNo: 'RF-notify' });
      expect(result.status).toBe(200);

      const { headers, body } = received.at(-1)!;
      expect(
        verifyWithKey(
          rules.keys.platformPublicKeyPem,
          signatureMessage(headers['wechatpay-timestamp']!, headers['wechatpay-nonce']!, body),
          headers['wechatpay-signature']!,
        ),
      ).toBe(true);

      const { envelope, plaintext } = decrypt(body);
      expect(envelope.event_type).toBe('REFUND.SUCCESS');
      // A client that hard-codes 'transaction' as the AAD cannot read this.
      expect((envelope.resource as { associated_data: string }).associated_data).toBe('refund');
      expect(plaintext).toMatchObject({
        out_refund_no: 'RF-notify',
        out_trade_no: 'N-refund',
        refund_status: 'SUCCESS',
      });
    });

    it('delivers the abnormal outcome too', async () => {
      const result = await rules.postRefundNotify(notifyUrl, {
        outRefundNo: 'RF-notify',
        eventType: 'REFUND.ABNORMAL',
      });
      expect(result.status).toBe(200);
      const { plaintext } = decrypt(received.at(-1)!.body);
      expect(plaintext).toMatchObject({ refund_status: 'ABNORMAL' });
    });

    it('refuses to notify about a refund it never issued', async () => {
      await expect(rules.postRefundNotify(notifyUrl, { outRefundNo: 'nope' })).rejects.toThrow(
        '未知退款单',
      );
    });
  });

  it('serves a genuinely encrypted certificate payload', async () => {
    const response = await fetch(`${rules.url}/v3/certificates`);
    expect(response.status).toBe(200);
    const entry = (await response.json()).data[0];
    expect(entry.serial_no).toBe(rules.keys.platformSerial);

    const encrypted = entry.encrypt_certificate;
    expect(encrypted.algorithm).toBe('AEAD_AES_256_GCM');
    const raw = Buffer.from(encrypted.ciphertext, 'base64');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(rules.keys.apiV3Key, 'utf8'),
      Buffer.from(encrypted.nonce),
    );
    decipher.setAAD(Buffer.from(encrypted.associated_data, 'utf8'));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const plaintext = Buffer.concat([
      decipher.update(raw.subarray(0, raw.length - 16)),
      decipher.final(),
    ]).toString('utf8');
    expect(plaintext).toBe(rules.keys.platformPublicKeyPem);
  });
});
