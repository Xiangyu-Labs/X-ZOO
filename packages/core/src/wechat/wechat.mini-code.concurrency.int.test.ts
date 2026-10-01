import { memoryStorage } from '../kernel/storage';
import { wechatMiniCodes } from '@shop/db/schema/wechat';
import { createTestCtx, flushTestRedis, forkTestCtx, type TestCtx } from '@shop/testing';
import { startFakeOaServer, type FakeOaServer } from '@shop/testing/wechat';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { wechatMiniConfig } from '../system';
import { resetWechatTokenFlight } from './wechat.client';
import { wechatConfig } from './wechat.config';
import { shareMiniCodeUrl } from './wechat.mini-code.service';

/**
 * Two shoppers share the same product in the same millisecond.
 *
 * The cache is a read followed by an insert, so both callers can miss, both
 * can generate, and both can try to record the result. `wechat_mini_codes`'
 * unique index is what decides; the service has to survive losing to it, and
 * the loser has to hand back the *winner's* URL — two different URLs for one
 * `(page, scene)` would mean the picture a shopper shared stops matching what
 * the shop later serves, and the orphaned file would never be pointed at by
 * anything.
 */

let harness: TestCtx;
let oa: FakeOaServer;
/** Shared by both forks, so "how many files exist" is one question. */
const storage = memoryStorage(() => new Date('2026-06-01T00:00:00.000Z'));

const NOW = '2026-06-01T00:00:00.000Z';
const TEAM = { route: 'groupbuyTeam', id: '88' } as const;

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW, storage });
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
  storage.files.clear();

  await harness.ctx.config.set(wechatConfig, {
    miniAppId: oa.miniAppId,
    miniAppSecret: oa.miniAppSecret,
    apiBaseUrl: oa.url,
  });
  await harness.ctx.config.set(wechatMiniConfig, { enabled: true });
});

describe('two callers, one pair', () => {
  it('agree on one URL, leave one row, and leave no orphaned file', async () => {
    const first = forkTestCtx(harness, { storage });
    const second = forkTestCtx(harness, { storage });

    const [a, b] = await Promise.all([
      shareMiniCodeUrl(first, TEAM),
      shareMiniCodeUrl(second, TEAM),
    ]);

    expect(a.url).toBe(b.url);

    const rows = await harness.ctx.db.select().from(wechatMiniCodes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).toBe(a.url);

    // Both may have called WeChat — that costs a quota unit and nothing else —
    // but only one file may survive, and it must be the one the row names.
    expect([...storage.files.keys()]).toEqual([rows[0]!.storageKey]);
  });
});
