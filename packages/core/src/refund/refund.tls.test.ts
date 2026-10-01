import { createSign, generateKeyPairSync, X509Certificate, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { Money } from '../kernel/money';
import { createWechatPayClient, type WechatPayCredentials } from '../wechat';

/**
 * TLS-001 for the refund client.
 *
 * `wechat.pay.tls.test.ts` shows the pay client refuses a gateway it cannot
 * authenticate, for the query and the close. The refund domain talks to WeChat
 * through the same client (`payClient(ctx)`), but through two other calls:
 * `createRefund` (money leaves the merchant) and `queryRefund` (the sweep's
 * answer to "did it?"). A transport that trusted any certificate there would
 * let an impostor say `SUCCESS` for a refund that never went out, or take the
 * merchant's signed refund request. So the same untrusted gateway is pointed at
 * those two calls.
 *
 * The fixture is a copy of the one in `wechat.pay.tls.test.ts` (a test file
 * cannot be imported without running its suite): a self-signed `localhost`
 * certificate minted per run, so no key material lives in the repository.
 *
 * The error must be the transport's `PAYMENT_STATE_UNKNOWN`, never
 * `PAYMENT_GATEWAY_REFUSED`: `executeRefund` reads a refusal as "the gateway did
 * not take the money" and makes the request retryable, while anything else parks
 * the refund in `unknown` for the sweep — which is right, because a failed
 * handshake is silence, not an answer.
 */

// --- a self-signed certificate, DER by hand ----------------------------------

function tlv(tag: number, content: Buffer): Buffer {
  const length = content.length;
  if (length < 0x80) return Buffer.concat([Buffer.from([tag, length]), content]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.concat([Buffer.from([tag, 0x80 | bytes.length, ...bytes]), content]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const explicit = (n: number, inner: Buffer): Buffer => tlv(0xa0 | n, inner);
const utf8 = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'));
const utcTime = (at: Date): Buffer =>
  tlv(0x17, Buffer.from(`${at.toISOString().slice(2, 19).replace(/[-T:]/g, '')}Z`, 'ascii'));
const bitString = (bytes: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), bytes]));

function integer(value: number): Buffer {
  const bytes: number[] = [];
  for (let n = value; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  if (bytes.length === 0 || bytes[0]! >= 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [a! * 40 + b!];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let n = arc >> 7; n > 0; n >>= 7) chunk.unshift(0x80 | (n & 0x7f));
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function selfSigned(key: { privateKey: KeyObject; publicKey: KeyObject }, host: string): string {
  const sha256WithRsa = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
  const name = seq(set(seq(oid('2.5.4.3'), utf8(host))));
  const now = Date.now();
  const subjectAltName = seq(
    oid('2.5.29.17'),
    tlv(0x04, seq(tlv(0x82, Buffer.from(host, 'ascii')), tlv(0x87, Buffer.from([127, 0, 0, 1])))),
  );
  const tbs = seq(
    explicit(0, integer(2)),
    integer(now % 1_000_000_000),
    sha256WithRsa,
    name,
    seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 24 * 3_600_000))),
    name,
    key.publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(subjectAltName)),
  );
  const signature = createSign('RSA-SHA256').update(tbs).sign(key.privateKey);
  const der = seq(tbs, sha256WithRsa, bitString(signature));
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

// --- the untrusted gateway ---------------------------------------------------

const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const certificate = selfSigned(key, 'localhost');
const privateKeyPem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeyPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();

let server: Server;
let port: number;
const received: string[] = [];

beforeAll(async () => {
  server = createServer({ key: privateKeyPem, cert: certificate }, (req, res) => {
    received.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
  expect(error, 'the refund client accepted an untrusted gateway').toBeInstanceOf(DomainError);
  return error as DomainError;
}

describe('TLS-001 — the refund client refuses a gateway it cannot authenticate', () => {
  it('mints a certificate the platform can parse, for the host the client dials', () => {
    const parsed = new X509Certificate(certificate);
    expect(parsed.checkHost('localhost')).toBe('localhost');
    expect(parsed.verify(key.publicKey)).toBe(true);
  });

  it('refuses the refund create at the handshake, so the request never reaches the server', async () => {
    received.length = 0;
    const client = createWechatPayClient(ctx, credentials(`https://localhost:${port}`));

    const error = await refusal(
      client.createRefund({
        outRefundNo: 'RF-TLS-1',
        outTradeNo: 'OT-TLS-1',
        transactionId: '4200000000000000000000000001',
        refundAmount: Money.parse('50.00'),
        totalAmount: Money.parse('50.00'),
        reason: 'TLS-001',
      }),
    );

    // Silence, not a refusal: the refund would be parked `unknown`, not failed.
    expect(error.code).toBe('PAYMENT_STATE_UNKNOWN');
    expect(error.details).toMatchObject({ reason: 'transport' });
    expect(received).toEqual([]);
  });

  it('refuses the refund query the same way — a SUCCESS is only trustworthy over an authenticated channel', async () => {
    received.length = 0;
    const client = createWechatPayClient(ctx, credentials(`https://localhost:${port}`));

    const error = await refusal(client.queryRefund('RF-TLS-2'));

    expect(error.code).toBe('PAYMENT_STATE_UNKNOWN');
    expect(error.details).toMatchObject({ reason: 'transport' });
    expect(received).toEqual([]);
  });
});
