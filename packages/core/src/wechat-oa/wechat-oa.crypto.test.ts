import { describe, expect, it } from 'vitest';
import {
  aesKeyOf,
  buildXml,
  cdata,
  decryptMessage,
  encryptMessage,
  encryptReply,
  equalsSignature,
  parseXml,
  signatureOf,
  verifyMessageSignature,
  verifySignature,
  WechatOaCryptoError,
} from './wechat-oa.crypto';

/**
 * The callback's front door, tested as vectors rather than as behaviour.
 *
 * This file is the reason the webhook integration test can argue about what the
 * service *does* with a trusted message instead of about whether it should have
 * trusted it. Everything here is pure: no `Ctx`, no clock, no network.
 */

const TOKEN = 'shoptoken';
const TIMESTAMP = '1767668400';
const NONCE = '1372623149';
/** `sha1(sort([token, timestamp, nonce]).join(''))`, computed by hand once. */
const PLAIN_SIGNATURE = '817796d6ec7582fbee55717afe0528492f96ce9e';
const APP_ID = 'wx0000000000000001';
/** 43 base64 characters, which is the only length WeChat ever issues. */
const AES_KEY = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

describe('signatureOf', () => {
  it('sorts the parts before hashing, so parameter order cannot matter', () => {
    expect(signatureOf([TOKEN, TIMESTAMP, NONCE])).toBe(PLAIN_SIGNATURE);
    expect(signatureOf([NONCE, TOKEN, TIMESTAMP])).toBe(PLAIN_SIGNATURE);
  });
});

describe('equalsSignature', () => {
  it('is false for a different length instead of throwing', () => {
    // `timingSafeEqual` throws on mismatched lengths; a webhook that 500s on a
    // truncated signature is a webhook WeChat retries three times.
    expect(equalsSignature(PLAIN_SIGNATURE, 'short')).toBe(false);
  });

  it('is true only for the same bytes', () => {
    expect(equalsSignature(PLAIN_SIGNATURE, PLAIN_SIGNATURE)).toBe(true);
    expect(equalsSignature(PLAIN_SIGNATURE, PLAIN_SIGNATURE.replace(/.$/, '0'))).toBe(false);
  });
});

describe('verifySignature', () => {
  it('accepts WeChat’s own triple', () => {
    expect(
      verifySignature({
        token: TOKEN,
        signature: PLAIN_SIGNATURE,
        timestamp: TIMESTAMP,
        nonce: NONCE,
      }),
    ).toBe(true);
  });

  it('refuses when the shop has configured no token', () => {
    // Otherwise an unconfigured install accepts `sha1(timestamp+nonce)`, which
    // anybody can compute from the query string they just sent.
    expect(
      verifySignature({
        token: '',
        signature: PLAIN_SIGNATURE,
        timestamp: TIMESTAMP,
        nonce: NONCE,
      }),
    ).toBe(false);
  });

  it('refuses a replay with a changed timestamp', () => {
    expect(
      verifySignature({
        token: TOKEN,
        signature: PLAIN_SIGNATURE,
        timestamp: '1767668401',
        nonce: NONCE,
      }),
    ).toBe(false);
  });
});

describe('verifyMessageSignature', () => {
  const ENCRYPT = 'CIPHERTEXT';
  const MSG_SIGNATURE = 'ceb6875ee9a1a70d9f992571c233767934e61dfe';

  it('binds the ciphertext', () => {
    expect(
      verifyMessageSignature({
        token: TOKEN,
        msgSignature: MSG_SIGNATURE,
        timestamp: TIMESTAMP,
        nonce: NONCE,
        encrypt: ENCRYPT,
      }),
    ).toBe(true);
  });

  it('refuses the same triple over a different ciphertext', () => {
    // The attack this exists to stop: replay the three plain parameters verbatim
    // against a body of the attacker's choosing.
    expect(
      verifyMessageSignature({
        token: TOKEN,
        msgSignature: MSG_SIGNATURE,
        timestamp: TIMESTAMP,
        nonce: NONCE,
        encrypt: 'SOMETHING ELSE',
      }),
    ).toBe(false);
  });
});

describe('aesKeyOf', () => {
  it('derives a 32-byte key whose first 16 bytes are the IV', () => {
    const { key, iv } = aesKeyOf(AES_KEY);
    expect(key).toHaveLength(32);
    expect(iv).toEqual(key.subarray(0, 16));
  });

  it('refuses anything that is not 43 characters', () => {
    expect(() => aesKeyOf('too-short')).toThrow(WechatOaCryptoError);
    expect(() => aesKeyOf(`${AES_KEY}X`)).toThrow(WechatOaCryptoError);
  });
});

describe('the AES envelope', () => {
  const MESSAGE = '<xml><Content><![CDATA[你好，优惠券]]></Content></xml>';

  it('round-trips a message with multibyte content', () => {
    const encrypted = encryptMessage({ encodingAesKey: AES_KEY, appId: APP_ID, message: MESSAGE });
    expect(decryptMessage({ encodingAesKey: AES_KEY, appId: APP_ID, encrypted })).toBe(MESSAGE);
  });

  it('pads to 32 bytes, not to AES’s own 16', () => {
    // A 17-byte message: the ciphertext must be a multiple of 32, or a decoder
    // that strips PKCS#7 at 16 truncates it.
    const encrypted = encryptMessage({
      encodingAesKey: AES_KEY,
      appId: APP_ID,
      message: 'x'.repeat(17),
    });
    expect(Buffer.from(encrypted, 'base64').length % 32).toBe(0);
  });

  it('refuses a message encrypted for another Official Account', () => {
    const encrypted = encryptMessage({
      encodingAesKey: AES_KEY,
      appId: 'wxSOMEBODYELSE0001',
      message: MESSAGE,
    });
    expect(() => decryptMessage({ encodingAesKey: AES_KEY, appId: APP_ID, encrypted })).toThrow(
      /appid-mismatch/,
    );
  });

  it('refuses a ciphertext that is not a whole number of blocks', () => {
    expect(() =>
      decryptMessage({
        encodingAesKey: AES_KEY,
        appId: APP_ID,
        encrypted: Buffer.from('not a real ciphertext').toString('base64'),
      }),
    ).toThrow(WechatOaCryptoError);
  });

  it('refuses a ciphertext encrypted under a different key', () => {
    const other = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';
    const encrypted = encryptMessage({ encodingAesKey: other, appId: APP_ID, message: MESSAGE });
    expect(() => decryptMessage({ encodingAesKey: AES_KEY, appId: APP_ID, encrypted })).toThrow(
      WechatOaCryptoError,
    );
  });
});

describe('parseXml', () => {
  it('reads CDATA and bare values alike', () => {
    const parsed = parseXml(
      '<xml><ToUserName><![CDATA[gh_1234567890ab]]></ToUserName>' +
        '<CreateTime>1767668400</CreateTime><MsgType><![CDATA[text]]></MsgType>' +
        '<Content><![CDATA[优惠券]]></Content><MsgId>24000000000000001</MsgId></xml>',
    );
    expect(parsed).toEqual({
      ToUserName: 'gh_1234567890ab',
      CreateTime: '1767668400',
      MsgType: 'text',
      Content: '优惠券',
      MsgId: '24000000000000001',
    });
  });

  it('returns an empty object for a body that is not XML at all', () => {
    // Which is what a probe of the public URL sends, and it must not throw.
    expect(parseXml('hello?')).toEqual({});
  });

  it('caps what it will read', () => {
    const huge = `<xml><A>${'x'.repeat(200_000)}</A><B>tail</B></xml>`;
    const parsed = parseXml(huge);
    expect(parsed['B']).toBeUndefined();
  });
});

describe('cdata / buildXml', () => {
  it('splits a `]]>` so it cannot close the section early', () => {
    expect(cdata('a]]>b')).toBe('<![CDATA[a]]]]><![CDATA[>b]]>');
    // `parseXml` reads the first section only and does not rejoin the two — it
    // parses what WeChat sends, and WeChat never sends `]]>`. The escape is
    // about what *we* write: without it the reply document would end early and
    // the rest of the customer's message would be markup.
  });

  it('writes numbers bare and strings wrapped, and drops undefined', () => {
    expect(buildXml({ CreateTime: 1767668400, MsgType: 'text', Absent: undefined })).toBe(
      '<xml><CreateTime>1767668400</CreateTime><MsgType><![CDATA[text]]></MsgType></xml>',
    );
  });
});

describe('encryptReply', () => {
  it('produces an envelope whose MsgSignature verifies over its own ciphertext', () => {
    const envelope = encryptReply({
      token: TOKEN,
      encodingAesKey: AES_KEY,
      appId: APP_ID,
      message: '<xml><Content><![CDATA[hi]]></Content></xml>',
      timestamp: TIMESTAMP,
      nonce: NONCE,
    });
    const parsed = parseXml(envelope);
    expect(
      verifyMessageSignature({
        token: TOKEN,
        msgSignature: parsed['MsgSignature'] ?? '',
        timestamp: TIMESTAMP,
        nonce: NONCE,
        encrypt: parsed['Encrypt'] ?? '',
      }),
    ).toBe(true);
    expect(
      decryptMessage({
        encodingAesKey: AES_KEY,
        appId: APP_ID,
        encrypted: parsed['Encrypt'] ?? '',
      }),
    ).toContain('hi');
  });
});
