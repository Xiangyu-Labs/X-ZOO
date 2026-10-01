import { wechatMiniCodes } from '@shop/db/schema/wechat';
import { createTestCtx, flushTestRedis, type TestCtx } from '@shop/testing';
import { startFakeOaServer, type FakeOaServer } from '@shop/testing/wechat';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../kernel/context';
import { wechatMiniConfig } from '../system';
import { resetWechatTokenFlight } from './wechat.client';
import { wechatConfig } from './wechat.config';
import { shareMiniCodeUrl } from './wechat.mini-code.service';

/**
 * `GET /api/v1/share/mini-codes`, read as a signed-in shopper with a loop.
 *
 * The `(page, scene)` cache makes the *same* pair free after the first call. A
 * *new* pair always costs a `wxa/getwxacodeunlimit` call, a PNG in the storage
 * root and a `wechat_mini_codes` row, and the product id in the scene is any
 * number the caller likes. Without a count of new pairs per account, one free
 * account could grow the uploads volume and the table without bound and spend
 * the mini program's API rate on it.
 *
 * So each user has a window of 30 *new* pairs an hour (`RATE_LIMITED` above
 * it). Cached pairs stay free.
 */

let harness: TestCtx;
let oa: FakeOaServer;

const NOW = '2026-06-01T00:00:00.000Z';

function shopper(): Ctx {
  return harness.as({ kind: 'user', id: 1, permissions: [], isSuper: false });
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

describe('how many new codes one shopper can mint', () => {
  it('stops minting new codes for one account well before a hundred in an hour', async () => {
    for (let i = 0; i < 100; i += 1) {
      await shareMiniCodeUrl(shopper(), { route: 'product', id: String(1000 + i) }).catch(
        () => undefined,
      );
    }
    expect(oa.callsTo('/wxa/getwxacodeunlimit').length).toBeLessThanOrEqual(30);
    expect((await harness.ctx.db.select().from(wechatMiniCodes)).length).toBeLessThanOrEqual(30);
  });

  it('answers RATE_LIMITED for the 31st new code in the hour, before calling WeChat', async () => {
    for (let i = 0; i < 30; i += 1) {
      await shareMiniCodeUrl(shopper(), { route: 'product', id: String(i + 1) });
    }
    await expect(shareMiniCodeUrl(shopper(), { route: 'product', id: '31' })).rejects.toMatchObject(
      {
        code: 'RATE_LIMITED',
      },
    );
    expect(oa.callsTo('/wxa/getwxacodeunlimit')).toHaveLength(30);
  });

  it('keeps serving codes that already exist, however far over budget', async () => {
    for (let i = 0; i < 30; i += 1) {
      await shareMiniCodeUrl(shopper(), { route: 'product', id: String(i + 1) });
    }
    const again = await shareMiniCodeUrl(shopper(), { route: 'product', id: '7' });
    expect(again.url).toMatch(/wechat-mini-code/);
    expect(oa.callsTo('/wxa/getwxacodeunlimit')).toHaveLength(30);
  });

  it('charges each account its own budget', async () => {
    for (let i = 0; i < 30; i += 1) {
      await shareMiniCodeUrl(shopper(), { route: 'product', id: String(i + 1) });
    }
    const other = harness.as({ kind: 'user', id: 2, permissions: [], isSuper: false });
    await expect(shareMiniCodeUrl(other, { route: 'product', id: '99' })).resolves.toHaveProperty(
      'url',
    );
  });
});
