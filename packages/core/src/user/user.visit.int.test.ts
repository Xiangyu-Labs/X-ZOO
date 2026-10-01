import { userVisits } from '@shop/db/schema/stats';
import { userAddresses } from '@shop/db/schema/user';
import { createTestCtx, flushTestRedis, type TestCtx } from '@shop/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { anonymousActor, type Ctx } from '../kernel/context';
import { clearStatsCache, statsConfig, userRegions, userStats } from '../stats';
import * as repo from './user.repo';
import { pruneVisits, recordVisit } from './user.visit.service';

/**
 * The page-view beacon, and the figure it exists to feed.
 *
 * The assertion that matters is not "a row was inserted" — it is that 访客数
 * moves. So the thing to prove is that the beacon and the aggregate agree about
 * what a visitor *is*: a signed-in user id, or failing that an address. A
 * recorder that wrote a row the aggregate did not count would leave the figure
 * at 0 with a full table, which is worse than an empty one.
 */

let harness: TestCtx;

/** Inside the default 30-day window `userStats` resolves with no `from`/`to`. */
const NOW = '2026-06-15T04:00:00.000Z';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await flushTestRedis(harness.redis);
  harness.clock.set(NOW);
});

function asVisitor(userId: number | null): Ctx {
  return harness.as(
    userId === null
      ? anonymousActor
      : { kind: 'user', id: userId, permissions: [], isSuper: false },
  );
}

function asAdmin(): Ctx {
  return harness.as({ kind: 'admin', id: 1, permissions: [], isSuper: true });
}

let sequence = 0;

async function makeUser(): Promise<number> {
  sequence += 1;
  const phone = `1380014${String(1000 + sequence).padStart(4, '0')}`;
  const row = await harness.ctx.withTx((tx) =>
    repo.insertUser(tx, {
      account: phone,
      phone,
      passwordHash: null,
      passwordAlgo: null,
      nickname: `访客${sequence}`,
      avatarUrl: null,
      registerSource: 'h5',
      registerIp: null,
      now: harness.clock.now(),
    }),
  );
  if (!row) throw new Error('fixture: insertUser refused');
  return row.id;
}

/** The two figures the beacon feeds, read the way the admin screen reads them. */
async function figures(): Promise<{ visitors: number; pageViews: number }> {
  // The page is cached per window in Redis; a test that did not clear it would
  // be asserting against the answer the previous test warmed.
  await clearStatsCache(asAdmin());
  const page = await userStats(asAdmin(), {});
  const of = (key: string): number =>
    page.metrics.find((metric) => metric.key === key)?.value ?? -1;
  return { visitors: of('visitors'), pageViews: of('pageViews') };
}

describe('the visits beacon', () => {
  it('makes 访客数 count 1', async () => {
    expect(await figures()).toEqual({ visitors: 0, pageViews: 0 });

    const userId = await makeUser();
    await recordVisit(
      asVisitor(userId),
      { path: '/pages/goods_details/index' },
      { ip: '203.0.113.7' },
    );

    expect(await figures()).toEqual({ visitors: 1, pageViews: 1 });
  });

  it('counts a visitor who has not signed in, by address', async () => {
    // Most storefront traffic is anonymous, which is why the route is
    // `user-optional`; `stats` already defines a visitor as
    // `coalesce(user_id, 'ip:' || ip)` and the beacon has to write rows that
    // definition can see.
    await recordVisit(asVisitor(null), { path: '/pages/index/index' }, { ip: '198.51.100.4' });
    await recordVisit(asVisitor(null), { path: '/pages/index/index' }, { ip: '198.51.100.9' });

    expect(await figures()).toEqual({ visitors: 2, pageViews: 2 });

    const rows = await harness.ctx.db.select().from(userVisits);
    expect(rows.map((row) => row.userId)).toEqual([null, null]);
  });

  it('drops a repeat of the same page within the minute, and keeps the next one', async () => {
    const userId = await makeUser();
    const beacon = (path: string): Promise<void> =>
      recordVisit(asVisitor(userId), { path }, { ip: '203.0.113.7' });

    // A mini program's `onShow` fires every time the visitor comes back from a
    // sub-page: tapping four products out of a category would record five
    // views of the category page inside a minute.
    await beacon('/pages/index/index');
    await beacon('/pages/index/index');
    await beacon('/pages/index/index');
    // A different page in the same minute is a different view, not a repeat.
    await beacon('/pages/goods_details/index');

    expect(await figures()).toEqual({ visitors: 1, pageViews: 2 });

    // And the throttle is a window, not a ban: the same page a minute later is
    // a visitor who really did come back. The window lives in Redis with a
    // real TTL, so expiring the key is how a minute passes here — the fake
    // clock moves the rows' timestamps, not `PEXPIRE`.
    await harness.redis.del(`visit:u:${userId}:/pages/index/index`);
    await beacon('/pages/index/index');
    expect(await figures()).toEqual({ visitors: 1, pageViews: 3 });
  });

  it('throttles each visitor separately', async () => {
    // One key per visitor: a busy shop would otherwise drop everybody's second
    // view of the home page.
    await recordVisit(asVisitor(null), { path: '/pages/index/index' }, { ip: '198.51.100.4' });
    await recordVisit(asVisitor(null), { path: '/pages/index/index' }, { ip: '198.51.100.9' });
    await recordVisit(asVisitor(null), { path: '/pages/index/index' }, { ip: '198.51.100.4' });

    expect(await figures()).toEqual({ visitors: 2, pageViews: 2 });
  });

  it('records the platform the beacon named, and the header otherwise', async () => {
    const userId = await makeUser();
    await recordVisit(
      asVisitor(userId),
      { path: '/pages/index/index', platform: 'wechat-mini' },
      { ip: '203.0.113.7' },
    );
    await recordVisit(asVisitor(userId), { path: '/pages/cart/index' }, { ip: '203.0.113.7' });

    const rows = await harness.ctx.db.select().from(userVisits);
    const byPath = new Map(rows.map((row) => [row.path, row]));
    // `wechat-mini` on the wire is `wechat_mini` in the enum.
    expect(byPath.get('/pages/index/index')?.platform).toBe('wechat_mini');
    // Nothing set `X-Client-Platform` in this harness, so the column is null
    // rather than a guessed `h5` — an unknown platform must not inflate the
    // breakdown's largest bar.
    expect(byPath.get('/pages/cart/index')?.platform).toBeNull();
  });
});

async function giveAddress(userId: number, provinceName: string, isDefault = true): Promise<void> {
  await harness.ctx.withTx((tx) =>
    repo.insertAddress(tx, {
      userId,
      receiverName: '张三',
      receiverPhone: '13800000000',
      provinceId: null,
      cityId: null,
      districtId: null,
      provinceName,
      cityName: '某市',
      districtName: null,
      detail: '某路 1 号',
      postCode: null,
      lng: null,
      lat: null,
      isDefault,
      now: harness.clock.now(),
    }),
  );
}

async function regionVisitors(): Promise<Record<string, number>> {
  await clearStatsCache(asAdmin());
  const { rows } = await userRegions(asAdmin(), { sortBy: 'visitors', limit: 50 });
  return Object.fromEntries(
    rows.filter((row) => row.visitors > 0).map((row) => [row.province, row.visitors]),
  );
}

describe('地域访客', () => {
  it('counts a signed-in visitor under their default address, and everybody else as 未知', async () => {
    const withAddress = await makeUser();
    await giveAddress(withAddress, '浙江省');
    const withoutDefault = await makeUser();
    await giveAddress(withoutDefault, '广东省', false);

    await recordVisit(
      asVisitor(withAddress),
      { path: '/pages/index/index' },
      { ip: '203.0.113.7' },
    );
    await recordVisit(
      asVisitor(withoutDefault),
      { path: '/pages/index/index' },
      { ip: '203.0.113.8' },
    );
    await recordVisit(asVisitor(null), { path: '/pages/index/index' }, { ip: '198.51.100.4' });

    // A non-default address says nothing about where the shopper is; and no
    // address is guessed from an IP.
    expect(await regionVisitors()).toEqual({ 浙江省: 1, 未知: 2 });
  });

  it('keeps the province a view was recorded with when the address later changes', async () => {
    const userId = await makeUser();
    await giveAddress(userId, '浙江省');
    await recordVisit(asVisitor(userId), { path: '/pages/index/index' }, { ip: '203.0.113.7' });

    await harness.ctx.db.delete(userAddresses);
    await giveAddress(userId, '上海市');
    await recordVisit(asVisitor(userId), { path: '/pages/cart/index' }, { ip: '203.0.113.7' });

    const rows = await harness.ctx.db.select().from(userVisits);
    expect(new Map(rows.map((row) => [row.path, row.province]))).toEqual(
      new Map([
        ['/pages/index/index', '浙江省'],
        ['/pages/cart/index', '上海市'],
      ]),
    );
  });
});

async function stays(): Promise<Array<number | null>> {
  const rows = await harness.ctx.db.select().from(userVisits).orderBy(userVisits.id);
  return rows.map((row) => row.stayMs);
}

describe('停留时长', () => {
  const path = '/pages/goods_details/index';

  it('attaches the hide report to the view, without adding one', async () => {
    const userId = await makeUser();
    await recordVisit(asVisitor(userId), { path }, { ip: '203.0.113.7' });
    harness.clock.advance(42_000);
    await recordVisit(asVisitor(userId), { path, stayMs: 42_000 }, { ip: '203.0.113.7' });

    expect(await stays()).toEqual([42_000]);
    expect((await figures()).pageViews).toBe(1);
  });

  it('attaches an anonymous visitor’s report to that address’s view only', async () => {
    await recordVisit(asVisitor(null), { path }, { ip: '198.51.100.4' });
    await recordVisit(asVisitor(null), { path }, { ip: '198.51.100.9' });
    harness.clock.advance(20_000);
    await recordVisit(asVisitor(null), { path, stayMs: 15_000 }, { ip: '198.51.100.9' });

    expect(await stays()).toEqual([null, 15_000]);
  });

  it('adds up the spells of a view the throttle kept as one', async () => {
    const userId = await makeUser();
    const beacon = (stayMs?: number) =>
      recordVisit(asVisitor(userId), stayMs === undefined ? { path } : { path, stayMs }, {
        ip: '203.0.113.7',
      });

    await beacon();
    harness.clock.advance(10_000);
    await beacon(10_000);
    // Back from a sub-page inside the minute: the show is collapsed into the
    // same view, and so is its time.
    await beacon();
    harness.clock.advance(25_000);
    await beacon(25_000);

    expect(await stays()).toEqual([35_000]);
  });

  it('never credits more time than has passed since the view, or more than the cap', async () => {
    const userId = await makeUser();
    await recordVisit(asVisitor(userId), { path }, { ip: '203.0.113.7' });

    harness.clock.advance(5_000);
    // A client that claims an hour five seconds after the view is believed
    // for five seconds.
    await recordVisit(asVisitor(userId), { path, stayMs: 3_600_000 }, { ip: '203.0.113.7' });
    expect(await stays()).toEqual([5_000]);

    harness.clock.advance(3 * 60 * 60_000);
    await recordVisit(asVisitor(userId), { path, stayMs: 3 * 60 * 60_000 }, { ip: '203.0.113.7' });
    expect(await stays()).toEqual([30 * 60_000]);
  });

  it('drops a report with no view to attach it to', async () => {
    const userId = await makeUser();
    await recordVisit(asVisitor(userId), { path, stayMs: 8_000 }, { ip: '203.0.113.7' });
    await recordVisit(asVisitor(userId), { path: '/pages/index/index' }, { ip: '203.0.113.7' });
    // A different page's view is not this page's.
    await recordVisit(asVisitor(userId), { path, stayMs: 8_000 }, { ip: '203.0.113.7' });

    expect(await stays()).toEqual([null]);
  });

  it('feeds 平均停留时长', async () => {
    const userId = await makeUser();
    await recordVisit(asVisitor(userId), { path }, { ip: '203.0.113.7' });
    await recordVisit(asVisitor(null), { path }, { ip: '198.51.100.4' });
    harness.clock.advance(90_000);
    await recordVisit(asVisitor(userId), { path, stayMs: 90_000 }, { ip: '203.0.113.7' });

    await clearStatsCache(asAdmin());
    const page = await userStats(asAdmin(), {});
    // One view reported 90 s; the other never reported and is not a zero.
    expect(page.metrics.find((metric) => metric.key === 'avgStay')?.value).toBe(90);
  });
});

describe('retention', () => {
  it('deletes the views older than the configured window, and nothing newer', async () => {
    await harness.ctx.config.set(statsConfig, { visitRetentionDays: 100 });
    await harness.ctx.db.insert(userVisits).values([
      { path: '/old', createdAt: new Date('2026-03-01T00:00:00.000Z') },
      { path: '/edge', createdAt: new Date('2026-03-07T04:00:01.000Z') },
      { path: '/new', createdAt: new Date('2026-06-01T00:00:00.000Z') },
    ]);

    // NOW is 2026-06-15T04:00Z; 100 days earlier is 2026-03-07T04:00Z.
    expect(await pruneVisits(harness.ctx)).toEqual({ deleted: 1 });
    const left = await harness.ctx.db.select().from(userVisits);
    expect(left.map((row) => row.path).sort()).toEqual(['/edge', '/new']);
  });

  it('drains a backlog in batches', async () => {
    await harness.ctx.db.insert(userVisits).values(
      Array.from({ length: 5 }, () => ({
        path: '/old',
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      })),
    );

    expect(await pruneVisits(harness.ctx, { limit: 2 })).toEqual({ deleted: 2 });
    expect(await pruneVisits(harness.ctx, { limit: 2 })).toEqual({ deleted: 2 });
    expect(await pruneVisits(harness.ctx, { limit: 2 })).toEqual({ deleted: 1 });
    expect(await pruneVisits(harness.ctx, { limit: 2 })).toEqual({ deleted: 0 });
  });

  it('keeps 400 days by default, so a month can be compared with a year ago', async () => {
    await harness.ctx.db.insert(userVisits).values([
      { path: '/last-year', createdAt: new Date('2025-06-01T00:00:00.000Z') },
      { path: '/too-old', createdAt: new Date('2025-05-01T00:00:00.000Z') },
    ]);

    expect(await pruneVisits(harness.ctx)).toEqual({ deleted: 1 });
    const left = await harness.ctx.db.select().from(userVisits);
    expect(left.map((row) => row.path)).toEqual(['/last-year']);
  });
});
