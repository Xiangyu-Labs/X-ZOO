import { buildMiniPush } from '@shop/testing/wechat';
import { describe, expect, it } from 'vitest';
import {
  decryptMessage,
  verifyMessageSignature,
  verifySignature,
  WechatMessageCryptoError,
} from './wechat.message-crypto';

/**
 * The shop's `WXBizMsgCrypt` against the independent one in `@shop/testing`
 * (`buildMiniPush`), which is written from WeChat's description, not from this.
 */

const TOKEN = 'mini-token-000001';
const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const APP_ID = 'wxfakemini000000001';
const message = { Event: 'trade_manage_remind_shipping', merchant_trade_no: 'P1', 中文: '好' };

describe('mini push crypto', () => {
  it('verifies and decrypts a safe-mode push', () => {
    const push = buildMiniPush({
      token: TOKEN,
      aesKey: AES_KEY,
      appId: APP_ID,
      message,
      mode: 'safe',
    });
    const encrypt = (JSON.parse(push.body) as { Encrypt: string }).Encrypt;
    expect(
      verifyMessageSignature({
        token: TOKEN,
        msgSignature: push.query['msg_signature'] ?? '',
        timestamp: push.query['timestamp'] ?? '',
        nonce: push.query['nonce'] ?? '',
        encrypt,
      }),
    ).toBe(true);
    const plain = decryptMessage({ encodingAesKey: AES_KEY, appId: APP_ID, encrypted: encrypt });
    expect(JSON.parse(plain)).toEqual(message);
  });

  it('refuses a message sealed for another appid', () => {
    const push = buildMiniPush({
      token: TOKEN,
      aesKey: AES_KEY,
      appId: 'wxsomeoneelse000001',
      message,
      mode: 'safe',
    });
    const encrypt = (JSON.parse(push.body) as { Encrypt: string }).Encrypt;
    expect(() =>
      decryptMessage({ encodingAesKey: AES_KEY, appId: APP_ID, encrypted: encrypt }),
    ).toThrow(WechatMessageCryptoError);
  });

  it('checks a plain-mode signature, and refuses a wrong token', () => {
    const push = buildMiniPush({ token: TOKEN, appId: APP_ID, message, mode: 'plain' });
    const args = {
      signature: push.query['signature'] ?? '',
      timestamp: push.query['timestamp'] ?? '',
      nonce: push.query['nonce'] ?? '',
    };
    expect(verifySignature({ token: TOKEN, ...args })).toBe(true);
    expect(verifySignature({ token: 'other', ...args })).toBe(false);
    expect(verifySignature({ token: '', ...args })).toBe(false);
  });
});
