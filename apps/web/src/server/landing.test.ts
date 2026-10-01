import { anonymousActor, createCtx, type Ctx } from '@shop/core/kernel';
import { describe, expect, it, vi } from 'vitest';
import { LANDING_BACKOFF_SEC, landingData, type LandingDeps } from './landing';

/**
 * What the landing page shows, and how often it may ask WeChat. The config
 * service, Redis and the 小程序码 service are stand-ins: nothing here reaches
 * a database or WeChat.
 */

type Values = Record<string, Record<string, unknown>>;

const CONFIGURED: Values = {
  site: { siteName: '某某小店', icpNumber: '沪ICP备00000000号-1', icpUrl: 'javascript:alert(1)' },
  'wechat-mini': { enabled: true, name: '某某小店商城' },
  wechat: { miniAppId: 'wx0000000000000000', miniAppSecret: 'not-a-real-secret' },
};

/** Just the Redis calls the page makes, over a Map; `ttl` records each key's last expiry. */
function fakeRedis() {
  const store = new Map<string, string>();
  const ttl = new Map<string, number>();
  return {
    store,
    ttl,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _ex: 'EX', seconds: number, nx?: 'NX') => {
      if (nx && store.has(key)) return null;
      store.set(key, value);
      ttl.set(key, seconds);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    expire: vi.fn(async (key: string, seconds: number) => {
      ttl.set(key, seconds);
      return 1;
    }),
  };
}

function ctxWith(values: Values, redis = fakeRedis(), failConfig = false): Ctx {
  const config = {
    get: async (group: { group: string; schema: { parse(v: unknown): unknown } }) => {
      if (failConfig) throw new Error('database down');
      return group.schema.parse(values[group.group] ?? {});
    },
  };
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return createCtx({
    config,
    redis,
    logger,
    actor: anonymousActor,
    platform: null,
    requestId: 'test',
  } as unknown as Parameters<typeof createCtx>[0]);
}

function minting(result: 'ok' | 'fail' = 'ok') {
  const mintCode = vi.fn<LandingDeps['mintCode']>(async () => {
    if (result === 'fail') throw new Error('WECHAT_MINI_CODE_FAILED');
    return { url: '/uploads/wechat-mini-code/code.png' };
  });
  return { mintCode };
}

describe('the landing page data', () => {
  it('shows the text fallback and never asks WeChat when the mini-program is not configured', async () => {
    for (const wechat of [
      { ...CONFIGURED, 'wechat-mini': { enabled: false } },
      { ...CONFIGURED, wechat: { miniAppId: 'wx0000000000000000', miniAppSecret: '' } },
    ]) {
      const deps = minting();
      const data = await landingData(ctxWith(wechat), deps);
      expect(data.codeUrl).toBeNull();
      expect(data.shopName).toBe('某某小店');
      expect(deps.mintCode).not.toHaveBeenCalled();
    }
  });

  it('shows the home code when configured, and serves it from Redis afterwards', async () => {
    const redis = fakeRedis();
    const ctx = ctxWith(CONFIGURED, redis);
    const deps = minting();

    const first = await landingData(ctx, deps);
    const second = await landingData(ctx, deps);

    expect(first).toMatchObject({
      shopName: '某某小店',
      miniName: '某某小店商城',
      codeUrl: '/uploads/wechat-mini-code/code.png',
    });
    expect(second.codeUrl).toBe(first.codeUrl);
    expect(deps.mintCode).toHaveBeenCalledTimes(1);
    expect(redis.store.has('landing:mini-code:lock:release')).toBe(false);
  });

  it('falls back to text when WeChat refuses, and does not ask again for ten minutes', async () => {
    const redis = fakeRedis();
    const ctx = ctxWith(CONFIGURED, redis);
    const deps = minting('fail');

    expect((await landingData(ctx, deps)).codeUrl).toBeNull();
    expect((await landingData(ctx, deps)).codeUrl).toBeNull();

    expect(deps.mintCode).toHaveBeenCalledTimes(1);
    expect(redis.ttl.get('landing:mini-code:lock:release')).toBe(LANDING_BACKOFF_SEC);
  });

  it('keeps a code minted for 体验版 apart from the release one', async () => {
    const redis = fakeRedis();
    redis.store.set('landing:mini-code:url:release', '/uploads/release.png');
    const trial = { ...CONFIGURED, 'wechat-mini': { enabled: true, codeEnvVersion: 'trial' } };
    const deps = minting();

    expect((await landingData(ctxWith(trial, redis), deps)).codeUrl).toBe(
      '/uploads/wechat-mini-code/code.png',
    );
    expect(deps.mintCode).toHaveBeenCalledTimes(1);
  });

  it('renders the fallback rather than failing when settings or Redis are down', async () => {
    const deps = minting();
    expect(await landingData(ctxWith(CONFIGURED, fakeRedis(), true), deps)).toEqual({
      shopName: null,
      miniName: null,
      codeUrl: null,
      footer: [],
    });

    const broken = fakeRedis();
    broken.get.mockRejectedValue(new Error('redis down'));
    expect((await landingData(ctxWith(CONFIGURED, broken), deps)).codeUrl).toBeNull();
    expect(deps.mintCode).not.toHaveBeenCalled();
  });

  it('names the shop when the mini-program has no name, and links only http(s) 备案 URLs', async () => {
    const data = await landingData(
      ctxWith({ ...CONFIGURED, 'wechat-mini': { enabled: false } }),
      minting(),
    );
    expect(data.miniName).toBe('某某小店');
    expect(data.footer).toEqual([{ text: '沪ICP备00000000号-1' }]);
  });
});
