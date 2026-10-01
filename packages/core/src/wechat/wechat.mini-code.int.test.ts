import { wechatMiniCodes } from '@shop/db/schema/wechat';
import { createTestCtx, flushTestRedis, type TestCtx } from '@shop/testing';
import { startFakeOaServer, type FakeOaServer } from '@shop/testing/wechat';
import { decodeScene } from '@shop/contracts/system/storefront-routes';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../kernel/context';
import { wechatMiniConfig } from '../system';
import { resetWechatTokenFlight } from './wechat.client';
import { wechatConfig } from './wechat.config';
import { shareMiniCodeUrl } from './wechat.mini-code.service';

/**
 * 小程序码 against a fake `api.weixin.qq.com`.
 *
 * The property worth a test: **the second caller does not reach WeChat**.
 * `wxa/getwxacodeunlimit` is quota'd per day and the answer for a
 * `(page, scene)` pair never changes, so a shop whose poster page asks on every
 * render burns the quota and then serves broken images to everyone. The fake
 * counts calls, so "hit once, then never again" is an assertion rather than a
 * hope.
 *
 * The other two are the failure shapes: a refusal must not be stored as a
 * picture, and an unconfigured mini program must not cost a call.
 */

let harness: TestCtx;
let oa: FakeOaServer;

const NOW = '2026-06-01T00:00:00.000Z';
const PAGE = 'pages/product/index';
const SCENE = 'id=1024';
const PRODUCT = { route: 'product', id: '1024' } as const;

function ctx(): Ctx {
  return harness.as({ kind: 'user', id: 1, permissions: [], isSuper: false });
}

function codeCalls(): number {
  return oa.callsTo('/wxa/getwxacodeunlimit').length;
}

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
  await flushTestRedis(harness.redis);
  harness.clock.set(NOW);
  oa.reset();
  resetWechatTokenFlight();

  await harness.ctx.config.set(wechatConfig, {
    miniAppId: oa.miniAppId,
    miniAppSecret: oa.miniAppSecret,
    apiBaseUrl: oa.url,
  });
  await harness.ctx.config.set(wechatMiniConfig, { enabled: true });
});

describe('the (page, scene) cache', () => {
  it('asks WeChat once for a pair and serves every later caller from the cache', async () => {
    const first = await shareMiniCodeUrl(ctx(), PRODUCT);
    expect(first.url).toMatch(/\.png$/);
    expect(codeCalls()).toBe(1);
    expect(oa.miniCodes).toEqual([{ page: PAGE, scene: SCENE }]);

    const second = await shareMiniCodeUrl(ctx(), PRODUCT);
    expect(second.url).toBe(first.url);
    expect(codeCalls()).toBe(1);

    // One row, and the bytes really are in storage under the key it names.
    const rows = await harness.ctx.db.select().from(wechatMiniCodes);
    expect(rows).toHaveLength(1);
    expect(await harness.ctx.storage.exists(rows[0]!.storageKey)).toBe(true);
    expect(rows[0]!.url).toBe(first.url);
  });

  it('keys the cache on the pair, not on the page alone', async () => {
    // Two products share a page path and differ only in the scene, which is the
    // common case: a cache keyed on `page` would hand every product the first
    // product's poster.
    const one = await shareMiniCodeUrl(ctx(), { route: 'product', id: '1' });
    const two = await shareMiniCodeUrl(ctx(), { route: 'product', id: '2' });
    expect(two.url).not.toBe(one.url);
    expect(codeCalls()).toBe(2);
  });

  it('turns a WeChat refusal into WECHAT_MINI_CODE_FAILED and caches nothing', async () => {
    // WeChat answers 200 with a JSON body on failure — an unpublished mini
    // program is `41030`. Storing that as a PNG would serve a broken image for
    // ever, and it is exactly what a client that trusted the status line does.
    oa.behaviour.failWxaCode = { errcode: 41030, errmsg: 'invalid page' };

    await expect(shareMiniCodeUrl(ctx(), PRODUCT)).rejects.toMatchObject({
      code: 'WECHAT_MINI_CODE_FAILED',
      details: { errcode: 41030 },
    });
    expect(await harness.ctx.db.select().from(wechatMiniCodes)).toHaveLength(0);

    // And the shop recovers by itself once the mini program is published: the
    // failure left nothing behind to invalidate.
    oa.behaviour.failWxaCode = null;
    await expect(shareMiniCodeUrl(ctx(), PRODUCT)).resolves.toMatchObject({
      url: expect.stringMatching(/\.png$/),
    });
  });

  it('refuses while the mini program is not configured, without calling WeChat', async () => {
    await harness.ctx.config.set(wechatMiniConfig, { enabled: false });
    await expect(shareMiniCodeUrl(ctx(), PRODUCT)).rejects.toMatchObject({
      code: 'AUTH_WECHAT_NOT_CONFIGURED',
    });
    expect(codeCalls()).toBe(0);
  });
});

describe('shareMiniCodeUrl', () => {
  it('takes the page from the catalogue and the scene from encodeScene — SHARE-001', async () => {
    const product = await shareMiniCodeUrl(ctx(), { route: 'product', id: '1024' });
    const team = await shareMiniCodeUrl(ctx(), { route: 'groupbuyTeam', id: '501' });
    const home = await shareMiniCodeUrl(ctx(), { route: 'home' });

    expect(oa.miniCodes).toEqual([
      { page: 'pages/product/index', scene: 'id=1024' },
      { page: 'packages/promo/groupbuy-team/index', scene: 'id=501' },
      { page: 'pages/index/index', scene: '_' },
    ]);
    // The page reads its params back from the scene it is opened with.
    expect(decodeScene('groupbuyTeam', oa.miniCodes[1]!.scene)).toEqual({ id: '501' });
    expect(new Set([product.url, team.url, home.url]).size).toBe(3);
  });

  it('refuses params that do not fit the key, without calling WeChat — SHARE-001', async () => {
    await expect(shareMiniCodeUrl(ctx(), { route: 'home', id: '1' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(shareMiniCodeUrl(ctx(), { route: 'product' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(codeCalls()).toBe(0);
    expect(await harness.ctx.db.select().from(wechatMiniCodes)).toHaveLength(0);
  });

  it('refuses a key the catalogue does not mark miniCode — SHARE-001', async () => {
    await expect(
      shareMiniCodeUrl(ctx(), { route: 'order' as never, id: '1' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(codeCalls()).toBe(0);
  });
});

describe('SHARE-003 — the version a code opens comes from config', () => {
  const sentEnv = () =>
    oa
      .callsTo('/wxa/getwxacodeunlimit')
      .map((call) => (call.body as { env_version?: string }).env_version);

  it('asks for release by default', async () => {
    await shareMiniCodeUrl(ctx(), { route: 'product', id: '7' });
    expect(sentEnv()).toEqual(['release']);
  });

  it('asks for the configured version, and caches per version', async () => {
    const release = await shareMiniCodeUrl(ctx(), { route: 'product', id: '7' });

    await harness.ctx.config.set(wechatMiniConfig, { enabled: true, codeEnvVersion: 'trial' });
    const trial = await shareMiniCodeUrl(ctx(), { route: 'product', id: '7' });
    const trialAgain = await shareMiniCodeUrl(ctx(), { route: 'product', id: '7' });
    expect(trial.url).not.toBe(release.url);
    expect(trialAgain.url).toBe(trial.url);

    // Back to release: the release code, never the trial one, and no new call.
    await harness.ctx.config.set(wechatMiniConfig, { enabled: true, codeEnvVersion: 'release' });
    expect((await shareMiniCodeUrl(ctx(), { route: 'product', id: '7' })).url).toBe(release.url);

    expect(sentEnv()).toEqual(['release', 'trial']);
    const rows = await harness.ctx.db.select().from(wechatMiniCodes);
    expect(rows.map((row) => row.page).sort()).toEqual([
      'pages/product/index',
      'trial:pages/product/index',
    ]);
  });
});
