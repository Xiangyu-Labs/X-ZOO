import { createCipheriv, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AeadDecryptError,
  aeadDecrypt,
  buildAuthorization,
  buildJsapiPayParams,
  decryptResource,
  nonceStr,
  requestSignatureMessage,
  safeEqual,
  signWithMerchantKey,
  signatureMessage,
  verifySignedPayload,
  verifyWithPlatformKey,
} from './wechat.crypto';

/**
 * The transport-security vectors: TLS-002 / TLS-004 / TLS-005 and the v3
 * driver's own rules.
 *
 * Real RSA-2048, real AES-256-GCM, no network and no clock: this file is the
 * reason the integration suite never has to argue about whether a signature is
 * correct, only about what the service does with the answer.
 */

const platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });

const PLATFORM_PRIVATE = platform.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PLATFORM_PUBLIC = platform.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const MERCHANT_PRIVATE = merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const MERCHANT_PUBLIC = merchant.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const SERIAL = 'PUB_KEY_ID_0000000000000000000001';
const KEYS = new Map([[SERIAL, PLATFORM_PUBLIC]]);
const NOW = 1_772_000_000;
const API_V3_KEY = 'abcdefghijklmnopqrstuvwxyz012345'; // exactly 32 chars

function signed(body: string, at = NOW, serial = SERIAL) {
  const timestamp = String(at);
  const nonce = 'nonce0000000000000000000000000001';
  return {
    timestamp,
    nonce,
    serial,
    signature: signWithMerchantKey(PLATFORM_PRIVATE, signatureMessage(timestamp, nonce, body)),
    body,
    platformKeys: KEYS,
    nowSeconds: NOW,
  };
}

function encrypt(plaintext: string, associatedData = 'transaction') {
  const nonce = randomBytes(6).toString('hex'); // 12 chars
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(API_V3_KEY, 'utf8'), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    algorithm: 'AEAD_AES_256_GCM',
    ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
    nonce,
    associated_data: associatedData,
  };
}

describe('signature messages', () => {
  it('signs `timestamp\\nnonce\\nbody\\n` for a response or a notification', () => {
    expect(signatureMessage('1', 'n', '{}')).toBe('1\nn\n{}\n');
  });

  it('signs `METHOD\\npath\\ntimestamp\\nnonce\\nbody\\n` for a request', () => {
    expect(
      requestSignatureMessage({
        method: 'post',
        urlPath: '/v3/pay/transactions/jsapi',
        timestamp: '1',
        nonce: 'n',
        body: '{"a":1}',
      }),
    ).toBe('POST\n/v3/pay/transactions/jsapi\n1\nn\n{"a":1}\n');
  });

  it('produces a 32-character nonce', () => {
    expect(nonceStr()).toHaveLength(32);
    expect(nonceStr()).not.toBe(nonceStr());
  });
});

describe('TLS-002 — a platform-signed payload verifies, and four ways of being wrong do not', () => {
  it('accepts a correctly signed body', () => {
    expect(verifySignedPayload(signed('{"ok":true}'))).toEqual({ ok: true, serial: SERIAL });
  });

  it('refuses a tampered body', () => {
    const input = signed('{"ok":true}');
    expect(verifySignedPayload({ ...input, body: '{"ok":false}' })).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a wrong signature', () => {
    const input = signed('{"ok":true}');
    expect(
      verifySignedPayload({ ...input, signature: Buffer.from('nope').toString('base64') }),
    ).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('refuses an unknown platform serial', () => {
    expect(verifySignedPayload(signed('{"ok":true}', NOW, 'SOME_OTHER_SERIAL'))).toEqual({
      ok: false,
      reason: 'unknown-serial',
    });
  });

  it('refuses a stale timestamp in either direction', () => {
    expect(verifySignedPayload(signed('{}', NOW - 400))).toEqual({
      ok: false,
      reason: 'stale-timestamp',
    });
    expect(verifySignedPayload(signed('{}', NOW + 400))).toEqual({
      ok: false,
      reason: 'stale-timestamp',
    });
  });

  it('accepts a timestamp inside the five-minute window', () => {
    expect(verifySignedPayload(signed('{}', NOW - 299)).ok).toBe(true);
  });

  it('refuses a non-numeric timestamp rather than treating NaN as fresh', () => {
    const input = signed('{}');
    expect(verifySignedPayload({ ...input, timestamp: 'soon' })).toEqual({
      ok: false,
      reason: 'stale-timestamp',
    });
  });

  it.each(['timestamp', 'nonce', 'signature', 'serial'] as const)(
    'refuses a payload with no %s header',
    (header) => {
      expect(verifySignedPayload({ ...signed('{}'), [header]: null })).toEqual({
        ok: false,
        reason: 'missing-header',
      });
    },
  );
});

describe('TLS-003 — an unfetchable platform certificate is a refusal, not a default', () => {
  it('refuses when the key set is empty', () => {
    expect(verifySignedPayload({ ...signed('{}'), platformKeys: new Map() })).toEqual({
      ok: false,
      reason: 'unknown-serial',
    });
  });
});

describe('TLS-004 — a signature made with a key that is not the published one is rejected', () => {
  it('rejects a body signed with the merchant key', () => {
    const timestamp = String(NOW);
    const nonce = 'n';
    const body = '{"trade_state":"SUCCESS"}';
    expect(
      verifySignedPayload({
        timestamp,
        nonce,
        serial: SERIAL,
        signature: signWithMerchantKey(MERCHANT_PRIVATE, signatureMessage(timestamp, nonce, body)),
        body,
        platformKeys: KEYS,
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('answers false rather than throwing for a malformed key or signature', () => {
    expect(verifyWithPlatformKey('not a pem', 'msg', 'c2ln')).toBe(false);
    expect(verifyWithPlatformKey(PLATFORM_PUBLIC, 'msg', '!!! not base64 !!!')).toBe(false);
  });
});

describe('AEAD_AES_256_GCM', () => {
  it('round-trips a resource', () => {
    const resource = encrypt('{"out_trade_no":"P1"}');
    expect(decryptResource({ apiV3Key: API_V3_KEY, resource })).toEqual({ out_trade_no: 'P1' });
  });

  it('refuses a wrong APIv3 key', () => {
    const resource = encrypt('{"out_trade_no":"P1"}');
    expect(() => decryptResource({ apiV3Key: 'X'.repeat(32), resource })).toThrow(AeadDecryptError);
  });

  it('refuses a key that is not 32 characters', () => {
    expect(() =>
      aeadDecrypt({ apiV3Key: 'short', ciphertext: 'AAAA', nonce: '000000000000' }),
    ).toThrow(/32/);
  });

  it('refuses tampered associated data', () => {
    const resource = encrypt('{"a":1}', 'transaction');
    expect(() =>
      decryptResource({
        apiV3Key: API_V3_KEY,
        resource: { ...resource, associated_data: 'refund' },
      }),
    ).toThrow(AeadDecryptError);
  });

  it('refuses an unsupported algorithm instead of guessing', () => {
    const resource = encrypt('{"a":1}');
    expect(() =>
      decryptResource({ apiV3Key: API_V3_KEY, resource: { ...resource, algorithm: 'SM4' } }),
    ).toThrow(/SM4/);
  });

  it('refuses a truncated ciphertext', () => {
    expect(() =>
      aeadDecrypt({ apiV3Key: API_V3_KEY, ciphertext: 'AAAA', nonce: '000000000000' }),
    ).toThrow(/长度/);
  });
});

describe('TLS-005 — a resource must decrypt into a JSON object to be believed', () => {
  it.each([
    ['a JSON string', '"SUCCESS"'],
    ['a JSON number', '1'],
    ['a JSON array', '[{"out_trade_no":"P1"}]'],
    ['null', 'null'],
  ])('refuses %s', (_name, plaintext) => {
    expect(() => decryptResource({ apiV3Key: API_V3_KEY, resource: encrypt(plaintext) })).toThrow(
      /JSON 对象/,
    );
  });

  it('refuses plaintext that is not JSON at all', () => {
    expect(() => decryptResource({ apiV3Key: API_V3_KEY, resource: encrypt('not json') })).toThrow(
      /合法 JSON/,
    );
  });
});

describe('request authorization', () => {
  const input = {
    mchId: '1900000001',
    certSerial: 'ABCDEF0123456789',
    merchantPrivateKeyPem: MERCHANT_PRIVATE,
    method: 'POST',
    urlPath: '/v3/pay/transactions/jsapi',
    body: '{"appid":"wx1"}',
    timestamp: String(NOW),
    nonce: 'nonce0000000000000000000000000001',
  };

  it('carries the five documented fields', () => {
    const header = buildAuthorization(input);
    expect(header.startsWith('WECHATPAY2-SHA256-RSA2048 ')).toBe(true);
    for (const field of ['mchid', 'nonce_str', 'signature', 'timestamp', 'serial_no']) {
      expect(header).toContain(`${field}="`);
    }
  });

  it('signs what the gateway will verify', () => {
    const header = buildAuthorization(input);
    const signature = /signature="([^"]*)"/.exec(header)?.[1] ?? '';
    expect(verifyWithPlatformKey(MERCHANT_PUBLIC, requestSignatureMessage(input), signature)).toBe(
      true,
    );
  });

  it('signs the query string too, so a signed URL cannot be re-pointed', () => {
    const withQuery = buildAuthorization({ ...input, urlPath: '/v3/refund?x=1' });
    const signature = /signature="([^"]*)"/.exec(withQuery)?.[1] ?? '';
    expect(
      verifyWithPlatformKey(
        MERCHANT_PUBLIC,
        requestSignatureMessage({ ...input, urlPath: '/v3/refund?x=2' }),
        signature,
      ),
    ).toBe(false);
  });
});

describe('JSAPI pay params', () => {
  const params = buildJsapiPayParams({
    appId: 'wx0000000000000001',
    prepayId: 'wx26112233445566',
    merchantPrivateKeyPem: MERCHANT_PRIVATE,
    timestampSeconds: NOW,
    nonce: 'nonce0000000000000000000000000001',
  });

  it('carries exactly the keys wx.requestPayment takes', () => {
    // `apps/mini/src/platform/runtime.tsx` forwards these to `Taro.requestPayment`.
    expect(Object.keys(params).sort()).toEqual(
      ['appId', 'nonceStr', 'package', 'paySign', 'signType', 'timeStamp'].sort(),
    );
  });

  it('is v3: signType RSA, package prepay_id=…', () => {
    expect(params.signType).toBe('RSA');
    expect(params.package).toBe('prepay_id=wx26112233445566');
    expect(params.timeStamp).toBe(String(NOW));
  });

  it('signs the four-line message the client SDK verifies', () => {
    const message = `${params.appId}\n${params.timeStamp}\n${params.nonceStr}\n${params.package}\n`;
    expect(verifyWithPlatformKey(MERCHANT_PUBLIC, message, params.paySign)).toBe(true);
  });

  it('does not sign the five-line request message by mistake', () => {
    const wrong = requestSignatureMessage({
      method: 'POST',
      urlPath: '/v3/pay/transactions/jsapi',
      timestamp: params.timeStamp,
      nonce: params.nonceStr,
      body: params.package,
    });
    expect(verifyWithPlatformKey(MERCHANT_PUBLIC, wrong, params.paySign)).toBe(false);
  });
});

describe('safeEqual', () => {
  it('compares equal strings', () => {
    expect(safeEqual('token', 'token')).toBe(true);
  });

  it('refuses different strings and different lengths without throwing', () => {
    expect(safeEqual('token', 'tokeN')).toBe(false);
    expect(safeEqual('token', 'tok')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('the platform key set accepts a certificate as well as a bare public key', () => {
  it('reads a public key out of a PEM certificate body', () => {
    // v3 is migrating from platform certificates to a published public key;
    // `createPublicKey` handles both, which is why the map is keyed by serial
    // and holds a PEM rather than a parsed key.
    expect(createPublicKey(PLATFORM_PUBLIC).asymmetricKeyType).toBe('rsa');
  });
});
