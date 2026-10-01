import { createCipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Builds a mini-program 消息推送 exactly as WeChat sends one to
 * `/api/v1/webhooks/wechat-mini` — the query string and the raw JSON body —
 * so a test can drive the webhook without a phone.
 *
 * The `WXBizMsgCrypt` envelope is implemented here a second time, from
 * WeChat's description rather than by importing the shop's own
 * `wechat.message-crypto.ts`: a helper that reused the code under test would
 * agree with it even when both are wrong.
 *
 * - **plain** (明文模式): `?signature=sha1(sort(token, timestamp, nonce))`, body
 *   the message itself.
 * - **safe** (安全模式): `?encrypt_type=aes&msg_signature=sha1(sort(token,
 *   timestamp, nonce, Encrypt))`, body `{"ToUserName", "Encrypt"}` where
 *   `Encrypt = base64(AES-256-CBC(random16 ‖ len32be ‖ message ‖ appid))`,
 *   PKCS#7-padded to 32 bytes, key `base64(aesKey + '=')`, IV its first 16 bytes.
 */

export interface MiniPushOptions {
  token: string;
  /** The 43-character EncodingAESKey; required for `safe`. */
  aesKey?: string;
  appId: string;
  message: Record<string, unknown>;
  mode: 'plain' | 'safe';
  /** Epoch seconds; defaults to now. */
  timestamp?: number;
  nonce?: string;
}

export interface BuiltMiniPush {
  query: Record<string, string>;
  body: string;
  /** `?a=b&…`, ready to append to the webhook URL. */
  search: string;
}

export function sha1Sorted(parts: readonly string[]): string {
  return createHash('sha1')
    .update([...parts].sort().join(''), 'utf8')
    .digest('hex');
}

export function encryptMiniPush(aesKey: string, appId: string, message: string): string {
  const key = Buffer.from(`${aesKey}=`, 'base64');
  if (key.length !== 32) throw new Error('EncodingAESKey must be 43 characters');
  const text = Buffer.from(message, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(text.length, 0);
  const plain = Buffer.concat([randomBytes(16), length, text, Buffer.from(appId, 'utf8')]);
  const pad = 32 - (plain.length % 32);
  const padded = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

export function buildMiniPush(options: MiniPushOptions): BuiltMiniPush {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? randomBytes(6).toString('hex');
  const message = JSON.stringify(options.message);
  let query: Record<string, string>;
  let body: string;
  if (options.mode === 'plain') {
    body = message;
    query = { signature: sha1Sorted([options.token, timestamp, nonce]), timestamp, nonce };
  } else {
    if (!options.aesKey) throw new Error('safe mode needs aesKey');
    const encrypt = encryptMiniPush(options.aesKey, options.appId, message);
    body = JSON.stringify({ ToUserName: 'gh_fakemini00001', Encrypt: encrypt });
    query = {
      signature: sha1Sorted([options.token, timestamp, nonce]),
      timestamp,
      nonce,
      encrypt_type: 'aes',
      msg_signature: sha1Sorted([options.token, timestamp, nonce, encrypt]),
    };
  }
  return { query, body, search: `?${new URLSearchParams(query).toString()}` };
}
