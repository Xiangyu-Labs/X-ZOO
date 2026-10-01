import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { smsConfig } from '../system';
import {
  aliyunTemplateParam,
  canonicalQuery,
  createAliyunSmsSender,
  percentEncode,
  signatureFor,
} from './sms-aliyun';
import {
  createTencentSmsSender,
  tc3Authorization,
  tc3CanonicalRequest,
  tc3StringToSign,
} from './sms-tencent';
import { fakeSmsSender } from './sms.fake';
import { nullSmsSender } from './sms.port';
import { smsProviderConfigured } from './sms.service';
import { CODE_LENGTH, codeKey, generateCode, resendKey } from './verification-code';

describe('percentEncode', () => {
  it('differs from encodeURIComponent exactly where Aliyun requires', () => {
    // The documented trap: RFC 3986 escapes `!'()*` and `encodeURIComponent`
    // does not. `~` must stay unescaped, which JavaScript already does.
    expect(percentEncode("!'()*")).toBe('%21%27%28%29%2A');
    expect(encodeURIComponent("!'()*")).toBe("!'()*");
    expect(percentEncode('~')).toBe('~');
  });

  it('escapes the characters a template parameter really contains', () => {
    expect(percentEncode('{"code":"012345"}')).toBe('%7B%22code%22%3A%22012345%22%7D');
  });
});

describe('canonicalQuery', () => {
  it('sorts by key and encodes both halves', () => {
    expect(canonicalQuery({ b: '2', a: '1', 'A~': '*' })).toBe('A~=%2A&a=1&b=2');
  });

  it('sorts ASCII-wise, so uppercase comes before lowercase', () => {
    // `Action` before `accessKey` — a locale-aware sort would swap them and
    // every signature would be rejected.
    expect(canonicalQuery({ accessKey: 'x', Action: 'SendSms' })).toBe(
      'Action=SendSms&accessKey=x',
    );
  });
});

describe('signatureFor', () => {
  it('signs `GET&%2F&<canonical query>` with a trailing-& key', () => {
    const params = { Action: 'SendSms', PhoneNumbers: '13800138000' };
    // Written out literally rather than rebuilt from the helpers: this is the
    // assertion, and deriving it from the code under test would prove nothing.
    const expected = createHmac('sha1', 'secret&')
      .update('GET&%2F&Action%3DSendSms%26PhoneNumbers%3D13800138000', 'utf8')
      .digest('base64');
    expect(signatureFor(params, 'secret')).toBe(expected);
  });
});

describe('createAliyunSmsSender', () => {
  const options = {
    accessKeyId: 'id',
    accessKeySecret: 'secret',
    regionId: 'cn-hangzhou',
    signName: '商城',
    now: () => new Date('2026-09-22T01:02:03.456Z'),
    nonce: () => 'fixed-nonce',
  };

  it('sends a signed GET with a second-resolution timestamp', async () => {
    let seen = '';
    const sender = createAliyunSmsSender({
      ...options,
      fetchImpl: async (url) => {
        seen = String(url);
        return new Response(JSON.stringify({ Code: 'OK', BizId: 'biz-1' }));
      },
    });

    const result = await sender.send({
      phone: '13800138000',
      templateId: 'SMS_1',
      params: [{ name: 'code', value: '012345' }],
    });

    expect(result).toEqual({ ok: true, messageId: 'biz-1' });
    // Aliyun rejects a timestamp carrying milliseconds.
    expect(seen).toContain('Timestamp=2026-09-22T01%3A02%3A03Z');
    expect(seen).toContain('SignatureNonce=fixed-nonce');
    expect(seen).toContain('&Signature=');
    expect(new URL(seen).searchParams.get('TemplateParam')).toBe('{"code":"012345"}');
  });

  it('names each variable, sends none for a template without, and refuses a nameless one', async () => {
    expect(
      aliyunTemplateParam([
        { name: 'order_id', value: 'SO1' },
        { name: 'name', value: '顺丰' },
      ]),
    ).toBe('{"order_id":"SO1","name":"顺丰"}');
    expect(aliyunTemplateParam([])).toBeUndefined();
    expect(aliyunTemplateParam([{ name: '', value: 'SO1' }])).toBeNull();

    const urls: string[] = [];
    const sender = createAliyunSmsSender({
      ...options,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ Code: 'OK' }));
      },
    });
    await sender.send({ phone: '13800138000', templateId: 'SMS_1', params: [], signName: '别名' });
    const sent = new URL(urls[0]!).searchParams;
    expect(sent.has('TemplateParam')).toBe(false);
    expect(sent.get('SignName')).toBe('别名');
    expect(
      await sender.send({
        phone: '13800138000',
        templateId: 'SMS_1',
        params: [{ name: '', value: 'x' }],
      }),
    ).toMatchObject({ ok: false, providerCode: 'PARAM_NAME_MISSING' });
    expect(urls).toHaveLength(1);
  });

  it('turns a provider refusal into a result, never a throw', async () => {
    const sender = createAliyunSmsSender({
      ...options,
      fetchImpl: async () =>
        new Response(JSON.stringify({ Code: 'isv.BUSINESS_LIMIT_CONTROL', Message: '触发限流' })),
    });
    await expect(
      sender.send({ phone: '13800138000', templateId: 'SMS_1', params: [] }),
    ).resolves.toEqual({
      ok: false,
      providerCode: 'isv.BUSINESS_LIMIT_CONTROL',
      error: '触发限流',
    });
  });

  it('turns a transport failure into a result too', async () => {
    // A DNS failure at 3am must be a 502 the shopper can retry, not a 500 and
    // a page of stack trace in the log.
    const sender = createAliyunSmsSender({
      ...options,
      fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
    });
    const result = await sender.send({ phone: '13800138000', templateId: 'SMS_1', params: [] });
    expect(result.ok).toBe(false);
    expect(result.providerCode).toBe('TRANSPORT');
  });
});

describe('nullSmsSender', () => {
  it('refuses rather than pretending to have sent', async () => {
    // The tempting alternative — log the code and return ok — turns an
    // unconfigured production shop into one where the code is in the log file.
    const result = await nullSmsSender.send({
      phone: '13800138000',
      templateId: '',
      params: [{ name: 'code', value: '000000' }],
    });
    expect(result.ok).toBe(false);
    expect(result.providerCode).toBe('NOT_CONFIGURED');
  });
});

describe('fakeSmsSender', () => {
  it('records what was sent and can be told to fail', async () => {
    const fake = fakeSmsSender();
    await fake.send({
      phone: '13800138000',
      templateId: 'SMS_1',
      params: [{ name: 'code', value: '123456' }],
    });
    expect(fake.lastCodeFor('13800138000')).toBe('123456');

    fake.failNext(1, { ok: false, providerCode: 'isv.OUT_OF_SERVICE' });
    await expect(
      fake.send({
        phone: '13800138000',
        templateId: 'SMS_1',
        params: [{ name: 'code', value: '654321' }],
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      fake.send({
        phone: '13800138000',
        templateId: 'SMS_1',
        params: [{ name: 'code', value: '111111' }],
      }),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe('verification code keys', () => {
  it('puts the scene in the key', () => {
    // Keyed on the phone number alone, a code sent to confirm a phone change
    // would also log you in.
    expect(codeKey('login', '13800138000')).toBe('sms:code:login:13800138000');
    expect(codeKey('bind-phone', '13800138000')).not.toBe(codeKey('login', '13800138000'));
  });

  it('keeps the resend guard in a separate key from the code', () => {
    // They have different lifetimes: consuming a code must not let the same
    // number immediately ask for another.
    expect(resendKey('login', '13800138000')).toBe('sms:resend:login:13800138000');
  });
});

describe('generateCode', () => {
  it('is always six digits, including the ones starting with zero', () => {
    // `rand(100000, 999999)` threw away a tenth of the space for nothing.
    for (let i = 0; i < 500; i += 1) {
      expect(generateCode()).toMatch(/^\d{6}$/);
    }
    expect(CODE_LENGTH).toBe(6);
  });

  it('covers the leading-zero range', () => {
    const codes = Array.from({ length: 2000 }, () => generateCode());
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
  });
});

/**
 * `resolveSender`'s rule, as the predicate `GET /api/v1/app/config` asks — the
 * same function `resolveSender` itself calls, so the two cannot disagree about
 * whether a code can be sent.
 */
describe('smsProviderConfigured', () => {
  const config = (values: Record<string, unknown>) => smsConfig.schema.parse(values);
  const ALIYUN = {
    provider: 'aliyun',
    aliyunAccessKeyId: 'LTAI-test',
    aliyunAccessKeySecret: 'secret',
    aliyunSignName: '示例商城',
  };

  it('is true for Aliyun with its key id, key secret and sign name', () => {
    expect(smsProviderConfigured(config(ALIYUN))).toBe(true);
  });

  it('is false while any of the three is blank', () => {
    for (const key of ['aliyunAccessKeyId', 'aliyunAccessKeySecret', 'aliyunSignName']) {
      expect(smsProviderConfigured(config({ ...ALIYUN, [key]: '' }))).toBe(false);
    }
  });

  it('is false for 不启用', () => {
    expect(smsProviderConfigured(config({ ...ALIYUN, provider: 'none' }))).toBe(false);
    expect(smsProviderConfigured(config({}))).toBe(false);
  });

  const TENCENT = {
    provider: 'tencent',
    tencentAppId: '1400000000',
    tencentSecretId: 'id',
    tencentSecretKey: 'key',
    tencentSignName: '示例商城',
  };

  it('is true for Tencent with its SdkAppId, SecretId, SecretKey and sign name', () => {
    expect(smsProviderConfigured(config(TENCENT))).toBe(true);
  });

  it('is false while any of the four is blank', () => {
    for (const key of ['tencentAppId', 'tencentSecretId', 'tencentSecretKey', 'tencentSignName']) {
      expect(smsProviderConfigured(config({ ...TENCENT, [key]: '' }))).toBe(false);
    }
  });
});

describe('TC3-HMAC-SHA256 (Tencent Cloud)', () => {
  const body = '{"PhoneNumberSet":["+8613800138000"]}';
  const bodyHash = createHash('sha256').update(body).digest('hex');
  // 2026-09-22T01:02:03Z; 16:02 the day before would give the wrong date in UTC+8.
  const timestamp = 1790038923;

  it('builds the canonical request from lowercase signed headers and the body hash', () => {
    expect(tc3CanonicalRequest(body)).toBe(
      [
        'POST',
        '/',
        '',
        'content-type:application/json; charset=utf-8',
        'host:sms.tencentcloudapi.com',
        'x-tc-action:sendsms',
        '',
        'content-type;host;x-tc-action',
        bodyHash,
      ].join('\n'),
    );
  });

  it('scopes the string to sign to the UTC date of the timestamp', () => {
    expect(new Date(timestamp * 1000).toISOString()).toBe('2026-09-22T01:02:03.000Z');
    const canonicalHash = createHash('sha256').update(tc3CanonicalRequest(body)).digest('hex');
    expect(tc3StringToSign(body, timestamp)).toBe(
      `TC3-HMAC-SHA256\n${timestamp}\n2026-09-22/sms/tc3_request\n${canonicalHash}`,
    );
  });

  it('signs with the key chained over TC3<key> → date → sms → tc3_request', () => {
    const step = (key: string | Buffer, value: string) =>
      createHmac('sha256', key).update(value).digest();
    const signingKey = step(step(step('TC3secret', '2026-09-22'), 'sms'), 'tc3_request');
    const signature = createHmac('sha256', signingKey)
      .update(tc3StringToSign(body, timestamp))
      .digest('hex');
    expect(tc3Authorization(body, timestamp, 'AKIDtest', 'secret')).toBe(
      `TC3-HMAC-SHA256 Credential=AKIDtest/2026-09-22/sms/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`,
    );
  });
});

describe('createTencentSmsSender', () => {
  const options = {
    sdkAppId: '1400000000',
    secretId: 'AKIDtest',
    secretKey: 'secret',
    signName: '示例商城',
    region: 'ap-guangzhou',
    now: () => new Date('2026-09-22T01:02:03.456Z'),
  };
  const message = {
    phone: '13800138000',
    templateId: '123456',
    params: [{ name: 'code', value: '012345' }],
  };

  it('POSTs a signed SendSms with the +86 number and positional template params', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const sender = createTencentSmsSender({
      ...options,
      fetchImpl: async (url, init) => {
        seen = { url: String(url), init: init ?? {} };
        return new Response(
          JSON.stringify({
            Response: { SendStatusSet: [{ Code: 'Ok', SerialNo: 'serial-1' }], RequestId: 'r' },
          }),
        );
      },
    });

    expect(await sender.send(message)).toEqual({ ok: true, messageId: 'serial-1' });
    expect(seen?.url).toBe('https://sms.tencentcloudapi.com/');
    const body = String(seen?.init.body);
    expect(JSON.parse(body)).toEqual({
      PhoneNumberSet: ['+8613800138000'],
      SmsSdkAppId: '1400000000',
      SignName: '示例商城',
      TemplateId: '123456',
      TemplateParamSet: ['012345'],
    });
    const headers = seen?.init.headers as Record<string, string>;
    expect(headers['X-TC-Action']).toBe('SendSms');
    expect(headers['X-TC-Version']).toBe('2021-01-11');
    expect(headers['X-TC-Region']).toBe('ap-guangzhou');
    // Seconds, and the same seconds the signature was made over.
    expect(headers['X-TC-Timestamp']).toBe('1790038923');
    expect(headers.Authorization).toBe(tc3Authorization(body, 1790038923, 'AKIDtest', 'secret'));
  });

  it('sends exactly the given variables in order, names ignored, and [] for none', async () => {
    const bodies: unknown[] = [];
    const sender = createTencentSmsSender({
      ...options,
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({ Response: { SendStatusSet: [{ Code: 'Ok' }], RequestId: 'r' } }),
        );
      },
    });
    await sender.send({
      phone: '13800138000',
      templateId: '520269',
      params: [
        { name: 'z', value: '顺丰' },
        { name: 'a', value: '' },
        { name: '', value: '3' },
      ],
    });
    await sender.send({ phone: '13800138000', templateId: '520269', params: [], signName: '别名' });
    expect(bodies).toEqual([
      expect.objectContaining({ SignName: '示例商城', TemplateParamSet: ['顺丰', '', '3'] }),
      expect.objectContaining({ SignName: '别名', TemplateParamSet: [] }),
    ]);
  });

  it('turns a request-level error into a result', async () => {
    const sender = createTencentSmsSender({
      ...options,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: 'bad' } },
          }),
        ),
    });
    expect(await sender.send(message)).toEqual({
      ok: false,
      providerCode: 'AuthFailure.SignatureFailure',
      error: 'bad',
    });
  });

  it("turns the number's own refusal into a result", async () => {
    const sender = createTencentSmsSender({
      ...options,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            Response: {
              SendStatusSet: [
                { Code: 'FailedOperation.TemplateIncorrectOrUnapproved', Message: 'x' },
              ],
            },
          }),
        ),
    });
    expect(await sender.send(message)).toMatchObject({
      ok: false,
      providerCode: 'FailedOperation.TemplateIncorrectOrUnapproved',
    });
  });

  it('turns a transport failure into a result too', async () => {
    const sender = createTencentSmsSender({
      ...options,
      fetchImpl: () => Promise.reject(new Error('ECONNRESET')),
    });
    expect(await sender.send(message)).toEqual({
      ok: false,
      providerCode: 'TRANSPORT',
      error: 'ECONNRESET',
    });
  });
});
