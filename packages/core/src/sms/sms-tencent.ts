import { createHash, createHmac } from 'node:crypto';
import type { SmsMessage, SmsSendResult, SmsSender } from './sms.port';

/**
 * Tencent Cloud 短信 (SendSms, API 2021-01-11) over the TC3-HMAC-SHA256 signature, hand-rolled
 * for the reasons `sms-aliyun.ts` gives: one signed POST, no SDK, testable without a network, and
 * the canonical request and string-to-sign pinned literally by a unit test.
 *
 * The signature, per Tencent's 签名方法 v3:
 *
 * 1. Canonical request: `POST\n/\n\n` + the signed headers, each `name:value\n` in lowercase
 *    (`content-type`, `host`, `x-tc-action`), a blank line, their names joined by `;`, and the
 *    hex SHA-256 of the exact body bytes.
 * 2. String to sign: `TC3-HMAC-SHA256\n<unix seconds>\n<UTC date>/sms/tc3_request\n` + the hex
 *    SHA-256 of the canonical request.
 * 3. Key: HMAC-SHA256 chained over `TC3<SecretKey>` → date → `sms` → `tc3_request`; the
 *    signature is the hex HMAC of the string to sign under it.
 *
 * The date is the UTC date of the timestamp, not the local one: a Beijing-time date is a day off
 * for eight hours of every day, and those sends fail with `AuthFailure.SignatureFailure`.
 *
 * Template variables are positional in Tencent (`{1}`, `{2}`…): `TemplateParamSet` is the
 * message's params list, in order, names ignored, and an empty array for a template with no
 * variables. Tencent refuses a send whose count differs from the approved template. The
 * verification code sends one, the code, so its template has exactly one variable.
 */

const HOST = 'sms.tencentcloudapi.com';
const ENDPOINT = `https://${HOST}/`;
const ACTION = 'SendSms';
const API_VERSION = '2021-01-11';
const SERVICE = 'sms';
const ALGORITHM = 'TC3-HMAC-SHA256';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const SIGNED_HEADERS = 'content-type;host;x-tc-action';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

export function tc3CanonicalRequest(body: string): string {
  return [
    'POST',
    '/',
    '',
    `content-type:${CONTENT_TYPE}\nhost:${HOST}\nx-tc-action:${ACTION.toLowerCase()}\n`,
    SIGNED_HEADERS,
    sha256Hex(body),
  ].join('\n');
}

export function tc3StringToSign(body: string, timestamp: number): string {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  return [
    ALGORITHM,
    String(timestamp),
    `${date}/${SERVICE}/tc3_request`,
    sha256Hex(tc3CanonicalRequest(body)),
  ].join('\n');
}

export function tc3Authorization(
  body: string,
  timestamp: number,
  secretId: string,
  secretKey: string,
): string {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const signingKey = hmac(hmac(hmac(`TC3${secretKey}`, date), SERVICE), 'tc3_request');
  const signature = createHmac('sha256', signingKey)
    .update(tc3StringToSign(body, timestamp), 'utf8')
    .digest('hex');
  return `${ALGORITHM} Credential=${secretId}/${date}/${SERVICE}/tc3_request, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`;
}

export interface TencentSmsOptions {
  /** `SmsSdkAppId`, the 1400… number of the 短信 application. */
  sdkAppId: string;
  secretId: string;
  secretKey: string;
  /** The approved 签名 content, without the 【】. */
  signName: string;
  region: string;
  /** Required, for the reason `AliyunSmsOptions.now` gives. */
  now: () => Date;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface TencentResponse {
  Response?: {
    Error?: { Code?: string; Message?: string };
    SendStatusSet?: { Code?: string; Message?: string; SerialNo?: string }[];
    RequestId?: string;
  };
}

export function createTencentSmsSender(options: TencentSmsOptions): SmsSender {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;

  return {
    name: 'tencent',
    async send(message: SmsMessage): Promise<SmsSendResult> {
      const body = JSON.stringify({
        PhoneNumberSet: [`+86${message.phone}`],
        SmsSdkAppId: options.sdkAppId,
        SignName: message.signName || options.signName,
        TemplateId: message.templateId,
        TemplateParamSet: message.params.map((param) => param.value),
      });
      const timestamp = Math.floor(options.now().getTime() / 1000);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: tc3Authorization(body, timestamp, options.secretId, options.secretKey),
            'Content-Type': CONTENT_TYPE,
            'X-TC-Action': ACTION,
            'X-TC-Version': API_VERSION,
            'X-TC-Timestamp': String(timestamp),
            'X-TC-Region': options.region,
          },
          body,
          signal: controller.signal,
        });
        const parsed = ((await response.json()) as TencentResponse).Response ?? {};
        // A request-level failure (bad signature, no balance) is `Error`; a per-number one
        // (template not approved, frequency limit) is the number's own `Code`.
        if (parsed.Error) {
          return {
            ok: false,
            providerCode: parsed.Error.Code ?? String(response.status),
            error: parsed.Error.Message ?? '腾讯云短信接口返回失败',
          };
        }
        const status = parsed.SendStatusSet?.[0];
        if (status?.Code === 'Ok') {
          return { ok: true, ...(status.SerialNo ? { messageId: status.SerialNo } : {}) };
        }
        return {
          ok: false,
          providerCode: status?.Code ?? String(response.status),
          error: status?.Message ?? '腾讯云短信接口返回失败',
        };
      } catch (error) {
        return {
          ok: false,
          providerCode: 'TRANSPORT',
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
