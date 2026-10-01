import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * WeChat's message-callback envelope: the SHA-1 signature over the sorted
 * `token`, `timestamp`, `nonce` (and, in 安全模式, the ciphertext), and the
 * AES-256-CBC `Encrypt` element keyed by the 43-character `EncodingAESKey`.
 *
 * The Official Account callback (`wechat-oa`) and the mini program's message
 * push (`wechat.mini-push.ts`) use exactly the same scheme — WeChat ships one
 * `WXBizMsgCrypt` for both — so it lives here once, pure: no `Ctx`, no I/O.
 * `wechat-oa.crypto.ts` re-exports it under the names its callers have always
 * used, and keeps the XML half, which only the Official Account speaks.
 *
 * Nothing here decides *whether* to trust a callback on its own: the services
 * check the signature first, before any body is parsed, and only then decrypt.
 */

// ---------------------------------------------------------------------------
// signature
// ---------------------------------------------------------------------------

/** `sha1(sort(parts).join(''))` — WeChat's scheme for both signature flavours. */
export function signatureOf(parts: readonly string[]): string {
  return createHash('sha1')
    .update([...parts].sort().join(''), 'utf8')
    .digest('hex');
}

/** Constant-time compare of two hex digests. */
export function equalsSignature(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The URL-verification and plain-mode signature: `signature` over
 * `token`, `timestamp`, `nonce`.
 */
export function verifySignature(args: {
  token: string;
  signature: string;
  timestamp: string;
  nonce: string;
}): boolean {
  if (args.token === '') return false;
  return equalsSignature(signatureOf([args.token, args.timestamp, args.nonce]), args.signature);
}

/**
 * The safe-mode signature: `msg_signature` over `token`, `timestamp`, `nonce`
 * **and the ciphertext**.
 *
 * Binding the ciphertext is the whole point. Without it the three plain
 * parameters could be replayed verbatim against a body of the attacker's
 * choosing, and the decrypt step would then be the only check left — which it
 * cannot be, because a wrong key fails as garbage rather than as a refusal.
 */
export function verifyMessageSignature(args: {
  token: string;
  msgSignature: string;
  timestamp: string;
  nonce: string;
  encrypt: string;
}): boolean {
  if (args.token === '') return false;
  return equalsSignature(
    signatureOf([args.token, args.timestamp, args.nonce, args.encrypt]),
    args.msgSignature,
  );
}

// ---------------------------------------------------------------------------
// the AES envelope
// ---------------------------------------------------------------------------

export class WechatMessageCryptoError extends Error {
  constructor(
    readonly reason:
      'bad-aes-key' | 'bad-ciphertext' | 'bad-padding' | 'bad-length' | 'appid-mismatch',
  ) {
    super(`wechat message crypto: ${reason}`);
    this.name = 'WechatMessageCryptoError';
  }
}

/**
 * WeChat's `EncodingAESKey` is 43 base64 characters of a 32-byte key with the
 * trailing `=` chopped off. The IV is the key's own first 16 bytes — not a
 * choice we get to make, and not one worth hiding behind a constant.
 */
export function aesKeyOf(encodingAesKey: string): { key: Buffer; iv: Buffer } {
  const trimmed = encodingAesKey.trim();
  if (trimmed.length !== 43) throw new WechatMessageCryptoError('bad-aes-key');
  const key = Buffer.from(`${trimmed}=`, 'base64');
  if (key.length !== 32) throw new WechatMessageCryptoError('bad-aes-key');
  return { key, iv: key.subarray(0, 16) };
}

/**
 * WeChat pads to a 32-byte boundary, not to AES's own 16.
 *
 * So the cipher runs with `setAutoPadding(false)` and the padding is removed
 * here; letting Node strip it would silently truncate a message whose padding
 * happens to be 17–32 bytes.
 */
const BLOCK_SIZE = 32;

function unpad(buffer: Buffer): Buffer {
  const pad = buffer[buffer.length - 1] ?? 0;
  if (pad < 1 || pad > BLOCK_SIZE || pad > buffer.length)
    throw new WechatMessageCryptoError('bad-padding');
  return buffer.subarray(0, buffer.length - pad);
}

function pad(buffer: Buffer): Buffer {
  const amount = BLOCK_SIZE - (buffer.length % BLOCK_SIZE);
  return Buffer.concat([buffer, Buffer.alloc(amount, amount)]);
}

/**
 * Decrypts one `Encrypt` element.
 *
 * The plaintext is `16 random bytes | 4-byte big-endian length | message |
 * appid`. The appid at the end is checked against ours: it is what stops a
 * message encrypted for a *different* Official Account — one whose operator
 * happens to have our callback URL — from being processed as ours.
 */
export function decryptMessage(args: {
  encodingAesKey: string;
  appId: string;
  encrypted: string;
}): string {
  const { key, iv } = aesKeyOf(args.encodingAesKey);

  let raw: Buffer;
  try {
    const cipherText = Buffer.from(args.encrypted, 'base64');
    if (cipherText.length === 0 || cipherText.length % 16 !== 0) {
      throw new WechatMessageCryptoError('bad-ciphertext');
    }
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(false);
    raw = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  } catch (error) {
    if (error instanceof WechatMessageCryptoError) throw error;
    throw new WechatMessageCryptoError('bad-ciphertext');
  }

  const body = unpad(raw);
  if (body.length < 20) throw new WechatMessageCryptoError('bad-length');

  const length = body.readUInt32BE(16);
  if (length < 0 || 20 + length > body.length) throw new WechatMessageCryptoError('bad-length');

  const message = body.subarray(20, 20 + length).toString('utf8');
  const appId = body.subarray(20 + length).toString('utf8');
  if (args.appId !== '' && appId !== args.appId)
    throw new WechatMessageCryptoError('appid-mismatch');
  return message;
}

/** The inverse, for the encrypted reply. `random` is injectable so a test can pin the output. */
export function encryptMessage(args: {
  encodingAesKey: string;
  appId: string;
  message: string;
  random?: Buffer;
}): string {
  const { key, iv } = aesKeyOf(args.encodingAesKey);
  const message = Buffer.from(args.message, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.length, 0);

  const body = pad(
    Buffer.concat([
      args.random ?? randomBytes(16),
      length,
      message,
      Buffer.from(args.appId, 'utf8'),
    ]),
  );
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(body), cipher.final()]).toString('base64');
}
