import { beforeAll, describe, expect, it } from 'vitest';

import { fixedClock } from '../kernel/clock';
import type { ConfigGroupDef } from '../kernel/config-registry';
import { getConfigTest } from '../kernel/config-test';
import type { Ctx } from '../kernel/context';
import { wechatOaConfig } from '../system';
import { registerWechatOaConfigTest } from './wechat-oa.config-test';

const clock = fixedClock('2026-09-24T10:00:00Z');
const logger = { warn: () => undefined, error: () => undefined } as unknown as Ctx['logger'];

/** A ctx whose saved settings are `saved`, keyed by group. */
function ctxWith(saved: Record<string, Record<string, unknown>> = {}): Ctx {
  return {
    clock,
    logger,
    config: {
      get: async (def: ConfigGroupDef) => def.schema.parse(saved[def.group] ?? {}),
    },
  } as unknown as Ctx;
}

beforeAll(() => registerWechatOaConfigTest());

describe('wechat-oa 「模拟服务器校验」', () => {
  it('refuses a Token WeChat would not accept', async () => {
    const result = await getConfigTest('wechat-oa')!.run(
      ctxWith(),
      wechatOaConfig.schema.parse({ token: 'has space' }),
      {},
    );
    expect(result.steps[0]).toMatchObject({ name: '检查配置', ok: false });
  });

  it('asks for a 43-character key in safe mode', async () => {
    const result = await getConfigTest('wechat-oa')!.run(
      ctxWith(),
      wechatOaConfig.schema.parse({
        token: 'abc123',
        messageMode: 'safe',
        encodingAesKey: 'short',
      }),
      {},
    );
    expect(result.steps[0]!.detail).toBe('安全模式需要 43 位的 EncodingAESKey');
  });

  it('does not check a Token that is typed but not saved, and prints the URL', async () => {
    const result = await getConfigTest('wechat-oa')!.run(
      ctxWith({
        'wechat-oa': { token: 'saved1' },
        site: { publicOrigin: 'https://shop.example.com' },
        wechat: { oaAppId: 'wxoa' },
      }),
      wechatOaConfig.schema.parse({ token: 'typed2', enabled: true }),
      {},
    );
    expect(result.steps[0]).toMatchObject({ ok: true, detail: '明文模式' });
    expect(result.steps[1]!.ok).toBe(false);
    expect(result.steps[1]!.detail).toContain('Token 还没保存');
    expect(result.steps[1]!.detail).toContain('https://shop.example.com/api/v1/webhooks/wechat-oa');
  });

  it('refuses when the deployment has no public origin', async () => {
    const result = await getConfigTest('wechat-oa')!.run(
      ctxWith({ 'wechat-oa': { token: 'saved1' }, site: { publicOrigin: '' } }),
      wechatOaConfig.schema.parse({ token: 'saved1' }),
      {},
    );
    expect(result.steps[1]!.detail).toBe('没有公网地址：部署时未设置 PUBLIC_ORIGIN');
  });
});
