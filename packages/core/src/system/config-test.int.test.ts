import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { startFakeOaServer, type FakeOaServer } from '@shop/testing/wechat';
import type { Actor, Ctx } from '../kernel/context';
import { getConfigTest } from '../kernel/config-test';
import { resetWechatTokenFlight, wechatConfig } from '../wechat';
import { configGroupList, configTest } from './config.service';
import './index';
import '../domains.gen';

/**
 * 「测试」 on the settings screens, through the service the route calls.
 *
 * The WeChat group's hook is the one exercised end to end: it talks to the fake
 * OA server, so "the stored secret fills an empty box" and "a wrong secret is a
 * failed step, not a 500" are observed on the wire rather than asserted about a
 * stub. The refusals are the ones `configSave` makes, and they matter as much
 * here — a test that accepted `apiBaseUrl` from the form would send the stored
 * AppSecret to whatever host the form named.
 */

let harness: TestCtx;
let oa: FakeOaServer;

const NOW = '2026-09-22T08:00:00.000Z';

function as(permissions: string[], id = 7): Ctx {
  const actor: Actor = { kind: 'admin', id, permissions, isSuper: false };
  return harness.ctx.as(actor);
}

const WRITER = ['payment:config:read', 'payment:config:write', 'system:config:read'];

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
  oa = await startFakeOaServer();
}, 180_000);

afterAll(async () => {
  await oa?.close();
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
  harness.clock.set(NOW);
  oa.reset();
  resetWechatTokenFlight();
  // Stored the ordinary way; the form never shows `apiBaseUrl`.
  await harness.ctx.config.set(wechatConfig, {
    apiBaseUrl: oa.url,
    oaAppId: oa.appId,
    oaAppSecret: oa.appSecret,
  });
});

const tokenCalls = () => oa.callsTo('/cgi-bin/stable_token');

describe('configTest', () => {
  it('is registered for the WeChat group', () => {
    expect(getConfigTest('wechat')).toBeDefined();
  });

  it('tests the stored secret when the password box is left empty', async () => {
    const result = await configTest(as(WRITER), { group: 'wechat' }, { values: {}, input: {} });

    expect(result.ok).toBe(true);
    expect(result.steps).toEqual([
      expect.objectContaining({ name: '公众号：获取 access_token', ok: true }),
    ]);
    expect(tokenCalls()).toHaveLength(1);
    expect(tokenCalls()[0]!.body).toMatchObject({ appid: oa.appId, secret: oa.appSecret });
  });

  it('tests what is on the screen, and writes none of it back', async () => {
    const result = await configTest(
      as(WRITER),
      { group: 'wechat' },
      { values: { oaAppSecret: 'a-typo-in-the-box' }, input: {} },
    );

    // WeChat's refusal is the step's detail, not a 500.
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ ok: false });
    expect(result.steps[0]!.detail).toContain('40013');
    expect(tokenCalls()[0]!.body).toMatchObject({ secret: 'a-typo-in-the-box' });
    // The stored secret is untouched: the next test with an empty box passes.
    expect((await harness.ctx.config.get(wechatConfig)).oaAppSecret).toBe(oa.appSecret);
  });

  it('remembers the last result for the settings index', async () => {
    await configTest(as(WRITER), { group: 'wechat' }, { values: {}, input: {} });

    const list = await configGroupList(as(WRITER));
    const wechat = list.groups.find((group) => group.group === 'wechat');
    expect(wechat).toMatchObject({ testable: true, lastTest: { ok: true, at: NOW } });
  });

  it('refuses a caller who could read the settings but not save them', async () => {
    await expect(
      configTest(as(['payment:config:read']), { group: 'wechat' }, { values: {}, input: {} }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(tokenCalls()).toHaveLength(0);
  });

  it('refuses a key the form never shows, before anything is sent', async () => {
    // `apiBaseUrl` would point the probe — and the stored AppSecret — at any host.
    await expect(
      configTest(
        as(WRITER),
        { group: 'wechat' },
        { values: { apiBaseUrl: 'https://attacker.example' }, input: {} },
      ),
    ).rejects.toMatchObject({ code: 'SYSTEM_CONFIG_UNKNOWN_KEY' });
    expect(tokenCalls()).toHaveLength(0);
  });

  it('answers a group without a test as unsupported', async () => {
    await expect(
      configTest(
        as(['refund:config:read', 'refund:config:write']),
        { group: 'refund' },
        { values: {}, input: {} },
      ),
    ).rejects.toMatchObject({ code: 'SYSTEM_CONFIG_TEST_UNSUPPORTED' });
  });

  it('is rate limited per admin, because a test can send a billed SMS', async () => {
    for (let index = 0; index < 6; index += 1) {
      await configTest(as(WRITER), { group: 'wechat' }, { values: {}, input: {} });
    }
    await expect(
      configTest(as(WRITER), { group: 'wechat' }, { values: {}, input: {} }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // Another admin has their own allowance.
    await expect(
      configTest(as(WRITER, 8), { group: 'wechat' }, { values: {}, input: {} }),
    ).resolves.toMatchObject({ ok: true });
  });
});
