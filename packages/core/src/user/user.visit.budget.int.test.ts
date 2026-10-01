import { userVisits } from '@shop/db/schema/stats';
import { createTestCtx, flushTestRedis, type TestCtx } from '@shop/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { anonymousActor } from '../kernel/context';
import { recordVisit } from './user.visit.service';

/**
 * `POST /api/v1/visits`, read as somebody with a loop.
 *
 * The beacon is public and its throttle is keyed on `visit:<subject>:<path>`:
 * one row per visitor **per path** per minute. The path is the caller's to
 * choose (any `/…` up to 255 characters), so with that window alone a caller
 * who varies it is never throttled at all — every request is one `user_visits`
 * insert, and 浏览量 on the dashboard is whatever the caller wants it to be.
 * The per-path window is right for what it is for (collapsing `onShow`
 * re-fires); the per-subject ceiling of 60 rows a minute across paths is what
 * stops the loop, and above it the beacon is dropped silently, as a per-path
 * repeat is.
 */

let harness: TestCtx;

const NOW = '2026-06-15T04:00:00.000Z';
const ADDRESS = '198.51.100.23';

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

describe('what one anonymous address can write', () => {
  it('writes one row per path per minute, as designed', async () => {
    const anonymous = harness.as(anonymousActor);
    for (let i = 0; i < 5; i += 1) {
      await recordVisit(anonymous, { path: '/pages/index/index' }, { ip: ADDRESS });
    }
    expect(await harness.ctx.db.select().from(userVisits)).toHaveLength(1);
  });

  it('cannot write more than a browsing session’s worth of rows in a minute', async () => {
    const anonymous = harness.as(anonymousActor);
    // Nobody browses 200 distinct pages in one minute; a script does.
    for (let i = 0; i < 200; i += 1) {
      await recordVisit(anonymous, { path: `/pages/goods_details/index/${i}` }, { ip: ADDRESS });
    }
    const rows = await harness.ctx.db.select().from(userVisits);
    expect(rows.length).toBeLessThanOrEqual(60);
  });

  it('lets a real browsing minute through untouched: sixty distinct pages', async () => {
    const anonymous = harness.as(anonymousActor);
    for (let i = 0; i < 60; i += 1) {
      await recordVisit(anonymous, { path: `/pages/goods_details/index/${i}` }, { ip: ADDRESS });
    }
    expect(await harness.ctx.db.select().from(userVisits)).toHaveLength(60);
  });

  it('does not spend the ceiling on the per-path repeats it already collapses', async () => {
    const anonymous = harness.as(anonymousActor);
    // `onShow` re-firing on one page all minute long…
    for (let i = 0; i < 100; i += 1) {
      await recordVisit(anonymous, { path: '/pages/index/index' }, { ip: ADDRESS });
    }
    // …leaves the visitor's other 59 pages countable.
    for (let i = 0; i < 59; i += 1) {
      await recordVisit(anonymous, { path: `/pages/goods_details/index/${i}` }, { ip: ADDRESS });
    }
    expect(await harness.ctx.db.select().from(userVisits)).toHaveLength(60);
  });

  it('counts again once the minute has passed', async () => {
    const anonymous = harness.as(anonymousActor);
    for (let i = 0; i < 70; i += 1) {
      await recordVisit(anonymous, { path: `/p/${i}` }, { ip: ADDRESS });
    }
    expect(await harness.ctx.db.select().from(userVisits)).toHaveLength(60);
    // The window lives in Redis; expiring it is how the minute passes here.
    await flushTestRedis(harness.redis);
    await recordVisit(anonymous, { path: '/p/next-minute' }, { ip: ADDRESS });
    expect(await harness.ctx.db.select().from(userVisits)).toHaveLength(61);
  });

  it('keeps one visitor’s ceiling off another', async () => {
    const anonymous = harness.as(anonymousActor);
    for (let i = 0; i < 70; i += 1) {
      await recordVisit(anonymous, { path: `/p/${i}` }, { ip: ADDRESS });
    }
    await recordVisit(anonymous, { path: '/p/0' }, { ip: '198.51.100.24' });
    expect(await harness.ctx.db.select().from(userVisits)).toHaveLength(61);
  });
});
