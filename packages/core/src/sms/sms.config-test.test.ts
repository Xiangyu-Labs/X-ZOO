import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { fixedClock } from '../kernel/clock';
import { getConfigTest } from '../kernel/config-test';
import type { Ctx } from '../kernel/context';
import { memoryStorage, type Storage } from '../kernel/storage';
import { smsConfig } from '../system';
import { registerSmsConfigTest } from './sms.config-test';
import { fakeSmsSender } from './sms.fake';
import { registerSmsSender, resetSmsSender } from './sms.port';

const clock = fixedClock('2026-09-24T10:00:00Z');
const logger = { warn: () => undefined } as unknown as Ctx['logger'];

function ctxWith(storage: Storage): Ctx {
  return { clock, storage, logger } as unknown as Ctx;
}

const smsValues = (patch: Record<string, unknown> = {}) =>
  smsConfig.schema.parse({
    provider: 'tencent',
    tencentAppId: '1400000000',
    tencentSecretId: 'id',
    tencentSecretKey: 'key',
    tencentSignName: '某某商城',
    templateVerifyCode: '2433',
    ...patch,
  });

beforeAll(() => registerSmsConfigTest());

describe('sms 「发送测试短信」', () => {
  afterEach(() => resetSmsSender());

  it('sends the verification template to the phone typed', async () => {
    const fake = fakeSmsSender();
    registerSmsSender(fake);
    const hook = getConfigTest('sms')!;

    const result = await hook.run(ctxWith(memoryStorage()), smsValues(), { phone: '13800138000' });

    expect(result.ok).toBe(true);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ phone: '13800138000', templateId: '2433' });
    expect(result.steps.at(-1)?.detail).toBe('已受理，消息 ID fake-1');
  });

  it("shows the provider's refusal as a failed step", async () => {
    const fake = fakeSmsSender();
    fake.failNext(1, { providerCode: 'FailedOperation.SignatureIncorrect', error: '签名不正确' });
    registerSmsSender(fake);

    const result = await getConfigTest('sms')!.run(ctxWith(memoryStorage()), smsValues(), {
      phone: '13800138000',
    });

    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({
      name: '发送验证码短信',
      ok: false,
      detail: 'FailedOperation.SignatureIncorrect · 签名不正确',
    });
  });

  it('refuses before sending when no provider is chosen', async () => {
    const result = await getConfigTest('sms')!.run(
      ctxWith(memoryStorage()),
      smsValues({ provider: 'none' }),
      { phone: '13800138000' },
    );
    expect(result).toEqual({
      ok: false,
      steps: [{ name: '检查配置', ok: false, detail: '未选择短信服务商' }],
    });
  });

  it('refuses before sending without a verification template', async () => {
    registerSmsSender(fakeSmsSender());
    const result = await getConfigTest('sms')!.run(
      ctxWith(memoryStorage()),
      smsValues({ templateVerifyCode: '' }),
      { phone: '13800138000' },
    );
    expect(result.steps).toEqual([
      { name: '检查配置', ok: false, detail: '没有填写「验证码模板 ID」' },
    ]);
  });
});
