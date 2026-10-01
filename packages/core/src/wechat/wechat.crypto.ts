import {
  createDecipheriv,
  createPublicKey,
  createSign,
  createVerify,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

/**
 * WeChat Pay v3 cryptography — every byte of it, on `node:crypto`.
 *
 * There is no SDK here on purpose. The official SDKs pull in a certificate
 * downloader, a middleware stack and a cache of their own, and glue around an
 * SDK is where an "unverifiable signature silently becomes a valid response"
 * defect hides. Four pure functions and no ambient state is the whole
 * requirement.
 *
 * Nothing in this file touches the network, the clock or the database, so
 * `wechat.crypto.test.ts` runs in milliseconds and carries the TLS-002/004/005
 * vectors.
 */

/** The exact message v3 signs for a response or a notification. */
export function signatureMessage(timestamp: string, nonce: string, body: string): string {
  return `${timestamp}\n${nonce}\n${body}\n`;
}

/** The exact message v3 signs for an outgoing request. */
export function requestSignatureMessage(args: {
  method: string;
  urlPath: string;
  timestamp: string;
  nonce: string;
  body: string;
}): string {
  return `${args.method.toUpperCase()}\n${args.urlPath}\n${args.timestamp}\n${args.nonce}\n${args.body}\n`;
}

export function signWithMerchantKey(privateKeyPem: string, message: string): string {
  return createSign('RSA-SHA256').update(message, 'utf8').sign(privateKeyPem, 'base64');
}

/**
 * Verifies an RSA-SHA256 signature against a platform certificate or public key.
 *
 * Returns `false` for a malformed key or a malformed base64 signature rather
 * than throwing: a caller that has to wrap this in try/catch will eventually
 * wrap it in a `catch { return true }`. TLS-004 (a signature made with the
 * wrong key) and a corrupt header are the same answer — no.
 */
export function verifyWithPlatformKey(
  publicKeyOrCertPem: string,
  message: string,
  signatureBase64: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyOrCertPem);
    return createVerify('RSA-SHA256')
      .update(message, 'utf8')
      .verify(key, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

/** The WeChat-imposed replay window. Anything older is refused (TLS-002). */
export const SIGNATURE_MAX_SKEW_SECONDS = 300;

export interface SignatureHeaders {
  timestamp: string | null;
  nonce: string | null;
  signature: string | null;
  serial: string | null;
}

export type VerifyFailure =
  'missing-header' | 'stale-timestamp' | 'unknown-serial' | 'bad-signature';

export interface VerifyInput extends SignatureHeaders {
  body: string;
  /** `serial -> PEM`. A v3 platform *public key* is registered under its key id. */
  platformKeys: ReadonlyMap<string, string>;
  /** Seconds since the epoch, from `ctx.clock`. Never `Date.now()`. */
  nowSeconds: number;
  maxSkewSeconds?: number;
}

export type VerifyResult = { ok: true; serial: string } | { ok: false; reason: VerifyFailure };

/**
 * The one gate every inbound v3 payload passes through — a signed response and
 * a notification are verified identically, because they are signed identically.
 *
 * Order matters, and it is the cheap-and-certain checks first: a missing header
 * or a stale timestamp is decided without touching a key, and an unknown serial
 * is decided without an RSA operation. TLS-003 is the `unknown-serial` branch:
 * a platform certificate we could not fetch means we cannot verify, which means
 * we do not trust — never "assume good".
 */
export function verifySignedPayload(input: VerifyInput): VerifyResult {
  const { timestamp, nonce, signature, serial, body } = input;
  if (!timestamp || !nonce || !signature || !serial) return { ok: false, reason: 'missing-header' };

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, reason: 'stale-timestamp' };
  const skew = Math.abs(input.nowSeconds - seconds);
  if (skew > (input.maxSkewSeconds ?? SIGNATURE_MAX_SKEW_SECONDS)) {
    return { ok: false, reason: 'stale-timestamp' };
  }

  const key = input.platformKeys.get(serial);
  if (!key) return { ok: false, reason: 'unknown-serial' };

  const ok = verifyWithPlatformKey(key, signatureMessage(timestamp, nonce, body), signature);
  return ok ? { ok: true, serial } : { ok: false, reason: 'bad-signature' };
}

/** What `verifySignedPayload` refused, as a line safe to log and to store. */
export const VERIFY_FAILURE_MESSAGE: Record<VerifyFailure, string> = {
  'missing-header': '缺少微信支付签名头',
  'stale-timestamp': '签名时间戳超出允许范围',
  'unknown-serial': '未知的平台证书序列号',
  'bad-signature': '签名验证失败',
};

// ---------------------------------------------------------------------------
// AEAD
// ---------------------------------------------------------------------------

export class AeadDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AeadDecryptError';
  }
}

/**
 * `AEAD_AES_256_GCM`, the envelope every v3 `resource` and every encrypted
 * certificate uses.
 *
 * The APIv3 key is 32 ASCII characters and the nonce is 12; both are used as
 * raw UTF-8 bytes, which is WeChat's own (slightly odd) convention. The auth
 * tag is the last 16 bytes of the ciphertext.
 */
export function aeadDecrypt(args: {
  apiV3Key: string;
  ciphertext: string;
  nonce: string;
  associatedData?: string;
}): string {
  const key = Buffer.from(args.apiV3Key, 'utf8');
  if (key.length !== 32) throw new AeadDecryptError('APIv3 密钥必须是 32 个字符');
  const raw = Buffer.from(args.ciphertext, 'base64');
  if (raw.length <= 16) throw new AeadDecryptError('密文长度不足');
  const tag = raw.subarray(raw.length - 16);
  const data = raw.subarray(0, raw.length - 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(args.nonce, 'utf8'));
    decipher.setAuthTag(tag);
    decipher.setAAD(Buffer.from(args.associatedData ?? '', 'utf8'));
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new AeadDecryptError(`解密失败: ${error instanceof Error ? error.name : 'unknown'}`);
  }
}

/**
 * Decrypts and parses a `resource` into a JSON **object**.
 *
 * TLS-005 in one function: a notification is believed only if it verifies *and*
 * decrypts into an object. Valid JSON that is a string, a number or an array is
 * refused, because a forged "money received" that happens to decrypt to `"1"`
 * must not reach a handler that then reads `.out_trade_no` off `undefined`.
 */
export function decryptResource(args: {
  apiV3Key: string;
  resource: { ciphertext: string; nonce: string; associated_data?: string; algorithm?: string };
}): Record<string, unknown> {
  const algorithm = args.resource.algorithm ?? 'AEAD_AES_256_GCM';
  if (algorithm !== 'AEAD_AES_256_GCM') {
    throw new AeadDecryptError(`不支持的加密算法 ${algorithm}`);
  }
  const plaintext = aeadDecrypt({
    apiV3Key: args.apiV3Key,
    ciphertext: args.resource.ciphertext,
    nonce: args.resource.nonce,
    ...(args.resource.associated_data === undefined
      ? {}
      : { associatedData: args.resource.associated_data }),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new AeadDecryptError('解密结果不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AeadDecryptError('解密结果不是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// request signing
// ---------------------------------------------------------------------------

export interface AuthorizationInput {
  mchId: string;
  certSerial: string;
  merchantPrivateKeyPem: string;
  method: string;
  /** Path **and** query string, exactly as it goes on the wire. */
  urlPath: string;
  body: string;
  timestamp: string;
  nonce: string;
}

/** The `Authorization: WECHATPAY2-SHA256-RSA2048 …` header value. */
export function buildAuthorization(input: AuthorizationInput): string {
  const signature = signWithMerchantKey(
    input.merchantPrivateKeyPem,
    requestSignatureMessage({
      method: input.method,
      urlPath: input.urlPath,
      timestamp: input.timestamp,
      nonce: input.nonce,
      body: input.body,
    }),
  );
  return (
    'WECHATPAY2-SHA256-RSA2048 ' +
    `mchid="${input.mchId}",` +
    `nonce_str="${input.nonce}",` +
    `signature="${signature}",` +
    `timestamp="${input.timestamp}",` +
    `serial_no="${input.certSerial}"`
  );
}

/** 32 hex-ish characters, which is what WeChat's examples use. */
export function nonceStr(): string {
  return randomUUID().replace(/-/g, '').slice(0, 32);
}

/**
 * The `wx.requestPayment` / JSSDK payload.
 *
 * The signed message is `appId\ntimeStamp\nnonceStr\npackage\n` — four lines,
 * not the five of a request — and `signType` is `RSA`. Key spelling is WeChat's:
 * the mini program (`apps/mini/src/platform/runtime.tsx`) forwards it to
 * `wx.requestPayment` as is.
 */
export function buildJsapiPayParams(args: {
  appId: string;
  prepayId: string;
  merchantPrivateKeyPem: string;
  timestampSeconds: number;
  nonce?: string;
}): {
  appId: string;
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
} {
  const timeStamp = String(args.timestampSeconds);
  const nonce = args.nonce ?? nonceStr();
  const pkg = `prepay_id=${args.prepayId}`;
  const message = `${args.appId}\n${timeStamp}\n${nonce}\n${pkg}\n`;
  return {
    appId: args.appId,
    timeStamp,
    nonceStr: nonce,
    package: pkg,
    signType: 'RSA',
    paySign: signWithMerchantKey(args.merchantPrivateKeyPem, message),
  };
}

/**
 * Constant-time string comparison, for the OA message-callback token check.
 * Lengths differing is already public information, so an early return there is
 * fine; the bytes are not.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
