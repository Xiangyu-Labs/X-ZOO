import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { fixedClock } from '../kernel/clock';
import type { ConfigGroupDef } from '../kernel/config-registry';
import { getConfigTest } from '../kernel/config-test';
import type { Ctx } from '../kernel/context';
import { paymentConfig } from './payment.config';
import { registerPaymentConfigTest } from './payment.config-test';

const clock = fixedClock('2026-09-24T10:00:00Z');
const noop = (): void => undefined;
const logger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
} as unknown as Ctx['logger'];

/** A ctx whose saved settings are `saved`, keyed by group. */
function ctxWith(saved: Record<string, Record<string, unknown>> = {}): Ctx {
  return {
    clock,
    logger,
    config: {
      get: async (def: ConfigGroupDef) => def.schema.parse(saved[def.group] ?? {}),
    },
  } as unknown as Ctx;
}

beforeAll(() => registerPaymentConfigTest());
afterEach(() => vi.unstubAllGlobals());

describe('payment 「测试签名」', () => {
  const filled = {
    mchId: '1900000001',
    apiV3Key: 'a'.repeat(32),
    certSerial: 'SERIAL',
    merchantPrivateKey: 'not a pem',
    platformPublicKeyId: 'PUB_KEY_ID_1',
    platformPublicKey: 'not a pem',
    notifyBaseUrl: 'https://shop.example.com',
  };

  it('names every missing field', async () => {
    const result = await getConfigTest('payment')!.run(
      ctxWith(),
      paymentConfig.schema.parse({ mchId: '1900000001' }),
      {},
    );
    expect(result.steps[0]!.detail).toBe(
      '没有填写：APIv3 密钥、API 证书序列号、商户 API 私钥、微信支付公钥 ID、微信支付公钥、回调域名',
    );
  });

  it('refuses an APIv3 key of the wrong length before any request', async () => {
    const result = await getConfigTest('payment')!.run(
      ctxWith(),
      paymentConfig.schema.parse({ ...filled, apiV3Key: 'short' }),
      {},
    );
    expect(result.steps[0]!.detail).toBe('APIv3 密钥应为 32 位，现在是 5 位');
  });

  it('refuses a private key that is not PEM', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await getConfigTest('payment')!.run(
      ctxWith(),
      paymentConfig.schema.parse(filled),
      {},
    );
    expect(result.steps.at(-1)).toMatchObject({ name: '读取密钥', ok: false });
    expect(result.steps.at(-1)!.detail).toContain('商户 API 私钥');
    expect(fetch).not.toHaveBeenCalled();
  });
  describe('签名请求并验签应答', () => {
    const pem = () => {
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      return {
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      };
    };
    const merchant = pem();
    const platform = pem();
    const keyed = {
      ...filled,
      merchantPrivateKey: merchant.privateKey,
      platformPublicKey: platform.publicKey,
    };

    /** A `fetch` answering the way WeChat Pay does: every reply, refusals included, is signed. */
    function gatewayAnswers(status: number, body: object, signingKey = platform.privateKey) {
      const text = JSON.stringify(body);
      const timestamp = String(Math.floor(clock.now().getTime() / 1000));
      const nonce = 'n'.repeat(32);
      const signature = createSign('RSA-SHA256')
        .update(`${timestamp}\n${nonce}\n${text}\n`)
        .sign(signingKey, 'base64');
      const fetch = vi.fn(
        async (_url: string | URL | Request) =>
          new Response(text, {
            status,
            headers: {
              'content-type': 'application/json',
              'wechatpay-timestamp': timestamp,
              'wechatpay-nonce': nonce,
              'wechatpay-signature': signature,
              'wechatpay-serial': keyed.platformPublicKeyId,
            },
          }),
      );
      vi.stubGlobal('fetch', fetch);
      return fetch;
    }

    const run = () =>
      getConfigTest('payment')!.run(ctxWith(), paymentConfig.schema.parse(keyed), {});

    it('passes when WeChat answers a signed 订单不存在 (ORDER_NOT_EXIST, as v3 spells it)', async () => {
      const fetch = gatewayAnswers(404, { code: 'ORDER_NOT_EXIST', message: '订单不存在' });
      const result = await run();
      expect(String(fetch.mock.calls[0]![0])).toContain(
        '/v3/pay/transactions/out-trade-no/SHOPTEST',
      );
      expect(result.ok).toBe(true);
      expect(result.steps.at(-1)).toMatchObject({ name: '签名请求并验签应答', ok: true });
      expect(result.steps.at(-1)!.detail).toContain('微信支付接受了签名');
    });

    it('fails with the serial hint when WeChat refuses the signature', async () => {
      gatewayAnswers(401, { code: 'SIGN_ERROR', message: '签名错误' });
      const result = await run();
      expect(result.ok).toBe(false);
      expect(result.steps.at(-1)!.detail).toContain(
        '「API 证书序列号」与「商户 API 私钥」不是同一张证书',
      );
    });

    it('fails when the reply is not signed by the configured 微信支付公钥', async () => {
      gatewayAnswers(404, { code: 'ORDER_NOT_EXIST', message: '订单不存在' }, pem().privateKey);
      const result = await run();
      expect(result.ok).toBe(false);
      expect(result.steps.at(-1)!.detail).toContain('应答签名验不过');
    });
  });
});
