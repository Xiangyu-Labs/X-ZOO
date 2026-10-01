import { createHmac, randomUUID } from 'node:crypto';
import type { SmsMessage, SmsSendResult, SmsSender } from './sms.port';

/**
 * Aliyun 云通信 (Dysmsapi) over the RPC-style signature, hand-rolled.
 *
 * No `@alicloud/*` SDK: the whole protocol is one signed GET, the SDK pulls in
 * a dozen transitive packages and a build step, and pnpm 12 wants an approval
 * for each one. ~60 lines here, testable without a network, and the
 * string-to-sign is pinned literally by a unit test — that construction is the
 * part everybody gets wrong, and getting it wrong means every SMS is rejected
 * with `SignatureDoesNotMatch` and nobody can log in.
 *
 * The signature is HMAC-SHA1 over `GET&%2F&<canonicalised query>`, base64. The
 * two details that bite everybody: the percent-encoding is RFC 3986, which
 * escapes `!'()*` where `encodeURIComponent` leaves them alone, and the HMAC
 * key has a trailing `&`.
 */

const ENDPOINT = 'https://dysmsapi.aliyuncs.com/';
const API_VERSION = '2017-05-25';

/**
 * RFC 3986, which is `encodeURIComponent` plus `!'()*`.
 *
 * JavaScript already leaves `~` unescaped, so there is nothing to undo there —
 * the `%7E → ~` line every port of this routine carries is dead code copied
 * from the languages whose encoder does escape it.
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key] ?? '')}`)
    .join('&');
}

export function signatureFor(
  params: Record<string, string>,
  accessKeySecret: string,
  method = 'GET',
): string {
  const stringToSign = `${method}&${percentEncode('/')}&${percentEncode(canonicalQuery(params))}`;
  return createHmac('sha1', `${accessKeySecret}&`).update(stringToSign, 'utf8').digest('base64');
}

export interface AliyunSmsOptions {
  accessKeyId: string;
  accessKeySecret: string;
  regionId: string;
  signName: string;
  /**
   * Required, not defaulted to `new Date()`: `docs/conventions.md` bans an
   * ambient clock in `packages/core`, and the signature the request is rejected
   * or accepted on is *of* the timestamp — so a test that cannot pin it cannot
   * assert the signature at all.
   */
  now: () => Date;
  nonce?: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface AliyunResponse {
  Code?: string;
  Message?: string;
  BizId?: string;
  RequestId?: string;
}

/**
 * `TemplateParam`: the params by name, as an Aliyun template (`${code}`) names them. `null`
 * when one has no name — Aliyun would answer `isv.TEMPLATE_MISSING_PARAMETERS`, and a
 * nameless value has nowhere to go — and `undefined` when there are none to send.
 */
export function aliyunTemplateParam(params: SmsMessage['params']): string | null | undefined {
  if (params.length === 0) return undefined;
  const named: Record<string, string> = {};
  for (const { name, value } of params) {
    if (name === '') return null;
    named[name] = value;
  }
  return JSON.stringify(named);
}

export function createAliyunSmsSender(options: AliyunSmsOptions): SmsSender {
  const now = options.now;
  const nonce = options.nonce ?? (() => randomUUID());
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;

  return {
    name: 'aliyun',
    async send(message: SmsMessage): Promise<SmsSendResult> {
      const templateParam = aliyunTemplateParam(message.params);
      if (templateParam === null) {
        return {
          ok: false,
          providerCode: 'PARAM_NAME_MISSING',
          error: '阿里云短信模板变量没有填变量名',
        };
      }
      const params: Record<string, string> = {
        AccessKeyId: options.accessKeyId,
        Action: 'SendSms',
        Format: 'JSON',
        PhoneNumbers: message.phone,
        RegionId: options.regionId,
        SignName: message.signName || options.signName,
        SignatureMethod: 'HMAC-SHA1',
        SignatureNonce: nonce(),
        SignatureVersion: '1.0',
        TemplateCode: message.templateId,
        ...(templateParam === undefined ? {} : { TemplateParam: templateParam }),
        Timestamp: now()
          .toISOString()
          .replace(/\.\d{3}Z$/, 'Z'),
        Version: API_VERSION,
      };
      const signature = signatureFor(params, options.accessKeySecret);
      const url = `${ENDPOINT}?${canonicalQuery(params)}&Signature=${percentEncode(signature)}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(url, { method: 'GET', signal: controller.signal });
        const body = (await response.json()) as AliyunResponse;
        if (body.Code === 'OK') {
          return { ok: true, ...(body.BizId ? { messageId: body.BizId } : {}) };
        }
        return {
          ok: false,
          providerCode: body.Code ?? String(response.status),
          error: body.Message ?? '阿里云短信接口返回失败',
        };
      } catch (error) {
        // A timeout or a DNS failure is "could not send", not a crash.
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
