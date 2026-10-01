import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { probeWechatCredentials, WECHAT_API_TIMEOUT_MS } from './wechat.client';
import { createWechatPayClient, WECHAT_PAY_TIMEOUT_MS } from './wechat.pay';

/**
 * Every call to WeChat carries a deadline.
 *
 * They run on the effects dispatcher, one at a time, under a 60-second lease.
 * A request that never answered used to hold the dispatcher for as long as the
 * socket stayed open, and then run a second time when the lease lapsed. The
 * deadline is `AbortSignal.timeout`, so what these tests check is that the
 * signal is on the request, and that its firing is a transport failure — for
 * the pay client `PAYMENT_STATE_UNKNOWN`, never a confirmed answer.
 */

const noop = (): void => {};
const ctx = {
  clock: { now: () => new Date() },
  logger: { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop },
} as unknown as Ctx;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const timeoutError = (): DOMException =>
  new DOMException('The operation was aborted due to timeout', 'TimeoutError');

/** A `fetch` that records its init and fails the way an expired deadline does. */
function hangingFetch(): { inits: RequestInit[] } {
  const inits: RequestInit[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    inits.push(init ?? {});
    throw timeoutError();
  });
  return { inits };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WeChat calls time out instead of hanging the dispatcher', () => {
  it('keeps both deadlines well inside the effects lease', () => {
    expect(WECHAT_PAY_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    expect(WECHAT_API_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  it('sends a WeChat Pay call with a deadline, and a timeout is PAYMENT_STATE_UNKNOWN', async () => {
    const { inits } = hangingFetch();
    const client = createWechatPayClient(ctx, {
      mchId: '1900000109',
      apiV3Key: '0123456789abcdef0123456789abcdef',
      certSerial: 'MERCHANT-SERIAL',
      merchantPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      platformPublicKeyId: 'PUB_KEY_ID_TIMEOUT',
      platformPublicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      transactionNotifyUrl: 'https://shop.example.test/api/v1/webhooks/wechat-pay',
      refundNotifyUrl: 'https://shop.example.test/api/v1/webhooks/wechat-refund',
      apiBaseUrl: 'https://api.mch.weixin.qq.com',
    });

    const error = await client.queryTransaction('OT-TIMEOUT-1').then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(inits).toHaveLength(1);
    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('PAYMENT_STATE_UNKNOWN');
    expect((error as DomainError).details).toMatchObject({ reason: 'transport' });
  });

  it('sends the credential probe with a deadline too', async () => {
    const { inits } = hangingFetch();

    await expect(
      probeWechatCredentials({
        apiBaseUrl: 'https://api.weixin.qq.com',
        appId: 'wx0000000000000000',
        secret: 'not-a-secret',
      }),
    ).rejects.toThrow(/timeout/);

    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal);
  });
});
