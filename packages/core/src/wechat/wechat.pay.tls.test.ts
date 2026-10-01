import { X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import {
  startUntrustedHttpsServer,
  type UntrustedHttpsServer,
} from './__fixtures__/untrusted-https';
import { createWechatPayClient, type WechatPayCredentials } from './wechat.pay';

/**
 * TLS-001, the half `payment.config.test.ts` cannot see.
 *
 * That test proves no config group can grow a "verify SSL" switch. It says
 * nothing about whether the pay client actually verifies the peer — and MUT-001
 * showed it: `NODE_TLS_REJECT_UNAUTHORIZED = '0'` written into `wechat.pay.ts`
 * left every payment test green, because the fake gateway speaks plain HTTP.
 *
 * So here the gateway is an HTTPS server whose certificate nobody trusts: a
 * self-signed one for `localhost`, minted per run so no key material lives in
 * the repository (`__fixtures__/untrusted-https.ts`, shared with
 * `wechat.client.tls.test.ts`). The pay client must refuse it **at the transport** — the
 * request never reaches the server, and the error is the transport's
 * `PAYMENT_STATE_UNKNOWN`, not a signature failure on an answer it should
 * never have read. The control case shows the server itself is sound: a
 * client told to trust that one certificate talks to it fine.
 */

let gateway: UntrustedHttpsServer;
let port: number;
let received: string[];
let certificate: string;
let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(async () => {
  gateway = await startUntrustedHttpsServer(new Date());
  ({ port, received, certificate, privateKeyPem, publicKeyPem } = gateway);
});

afterAll(async () => {
  await gateway.close();
});

const noop = (): void => {};
const ctx = {
  clock: { now: () => new Date() },
  logger: { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop },
} as unknown as Ctx;

function credentials(apiBaseUrl: string): WechatPayCredentials {
  return {
    mchId: '1900000109',
    apiV3Key: '0123456789abcdef0123456789abcdef',
    certSerial: 'MERCHANT-SERIAL',
    merchantPrivateKey: privateKeyPem,
    platformPublicKeyId: 'PUB_KEY_ID_TLS',
    platformPublicKey: publicKeyPem,
    transactionNotifyUrl: 'https://shop.example.test/api/v1/webhooks/wechat-pay',
    refundNotifyUrl: 'https://shop.example.test/api/v1/webhooks/wechat-refund',
    apiBaseUrl,
  };
}

async function refusal(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, 'the pay client accepted an untrusted gateway').toBeInstanceOf(DomainError);
  return error as DomainError;
}

describe('TLS-001 — the pay client refuses a gateway it cannot authenticate', () => {
  it('mints a certificate the platform can parse, for the host the client dials', () => {
    const parsed = new X509Certificate(certificate);
    expect(parsed.checkHost('localhost')).toBe('localhost');
    expect(parsed.verify(gateway.publicKey)).toBe(true);
  });

  it('is a working HTTPS server for a client that was told to trust it', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', servername: 'localhost', port, path: '/control', ca: certificate },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
    expect(received).toContain('GET /control');
  });

  it('refuses the handshake, so the query never reaches the server', async () => {
    received.length = 0;
    const client = createWechatPayClient(ctx, credentials(`https://localhost:${port}`));

    const error = await refusal(client.queryTransaction('OT-TLS-1'));

    // A transport failure, not a signature failure: the client never read an
    // answer, because it never finished the handshake.
    expect(error.code).toBe('PAYMENT_STATE_UNKNOWN');
    expect(error.details).toMatchObject({ reason: 'transport' });
    expect(received).toEqual([]);
  });

  it('refuses the close the same way — a 204 is only trustworthy over an authenticated channel', async () => {
    received.length = 0;
    const client = createWechatPayClient(ctx, credentials(`https://localhost:${port}`));

    const error = await refusal(client.closeTransaction('OT-TLS-2'));

    expect(error.code).toBe('PAYMENT_STATE_UNKNOWN');
    expect(error.details).toMatchObject({ reason: 'transport' });
    expect(received).toEqual([]);
  });
});
