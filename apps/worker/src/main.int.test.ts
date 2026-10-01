import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { z } from 'zod';
import { defineJob, indexJobs } from './define-job';
import { allJobs } from './jobs.gen';
import { syncRepeatables } from './main';

/**
 * `syncRepeatables` against a real Redis.
 *
 * BullMQ keeps schedules in Redis, not in the code, so a cron that changed or
 * a job that was deleted keeps firing on the old schedule until something
 * removes it. That "something" is this function, and it is exactly the kind of
 * code that rots silently, so it gets a real test.
 */

let redis: Redis;
let queue: Queue;
const QUEUE = 'test-worker';
const logger = { info: () => {} };

beforeAll(async () => {
  const url = process.env.SHOP_TEST_REDIS_URL;
  if (!url) throw new Error('SHOP_TEST_REDIS_URL missing — run through the int project');
  redis = new Redis(url, { db: 15, maxRetriesPerRequest: null });
  queue = new Queue(QUEUE, { connection: redis });
}, 180_000);

afterAll(async () => {
  await queue?.close();
  redis?.disconnect();
});

beforeEach(async () => {
  await redis.flushdb();
});

const fakeJob = (name: string, every: number) =>
  defineJob({ name, schema: z.object({}).default({}), repeat: { every }, handler: async () => {} });

describe('syncRepeatables', () => {
  it('creates a scheduler for every repeatable job and none for the rest', async () => {
    const jobs = indexJobs([
      fakeJob('system.alpha', 1000),
      defineJob({
        name: 'system.onDemand',
        schema: z.object({}).default({}),
        handler: async () => {},
      }),
    ]);
    await syncRepeatables(queue, jobs, logger);

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.map((s) => s.name ?? s.key)).toEqual(['system.alpha']);
  });

  it('removes a schedule whose job no longer exists', async () => {
    await syncRepeatables(queue, indexJobs([fakeJob('system.retired', 1000)]), logger);
    expect(await queue.getJobSchedulers()).toHaveLength(1);

    await syncRepeatables(queue, indexJobs([fakeJob('system.alpha', 1000)]), logger);
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.map((s) => s.name ?? s.key)).toEqual(['system.alpha']);
  });

  it('updates a schedule in place when its interval changes', async () => {
    await syncRepeatables(queue, indexJobs([fakeJob('system.alpha', 1000)]), logger);
    await syncRepeatables(queue, indexJobs([fakeJob('system.alpha', 60_000)]), logger);

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(Number(schedulers[0]?.every)).toBe(60_000);
  });

  it('is idempotent — running it twice changes nothing', async () => {
    const jobs = indexJobs([fakeJob('system.alpha', 1000), fakeJob('system.beta', 2000)]);
    await syncRepeatables(queue, jobs, logger);
    const first = await queue.getJobSchedulers();
    await syncRepeatables(queue, jobs, logger);
    const second = await queue.getJobSchedulers();
    expect(second.map((s) => s.key).sort()).toEqual(first.map((s) => s.key).sort());
  });

  it('schedules the real job set this worker ships with', async () => {
    await syncRepeatables(queue, indexJobs(allJobs), logger);
    const names = (await queue.getJobSchedulers()).map((s) => s.name ?? s.key).sort();
    // Every scheduled job this worker ships with really got a scheduler, and
    // nothing was registered twice. Not a literal list: every domain adds jobs,
    // and a literal list would make each of them edit this file.
    const scheduled = allJobs
      .filter((definition) => definition.repeat && !definition.disabled)
      .map((definition) => definition.name)
      .sort();
    expect(names).toEqual(scheduled);
    expect(names).toEqual(
      expect.arrayContaining([
        'system.dispatchEffects',
        'system.heartbeat',
        'system.pruneSessions',
      ]),
    );
  });

  it('OPS-018 — bounds the failed runs a schedule keeps in Redis', async () => {
    // Redis runs `noeviction`: a sweep failing every five seconds through an
    // outage must not fill it until sessions cannot be written.
    await syncRepeatables(queue, indexJobs([fakeJob('system.alpha', 1000)]), logger);
    const [scheduler] = await queue.getJobSchedulers();
    expect(scheduler?.template?.opts).toMatchObject({
      removeOnComplete: { count: 100 },
      removeOnFail: { age: 24 * 3600, count: 200 },
    });
  });

  it('uses Asia/Shanghai for a cron schedule', async () => {
    const nightly = defineJob({
      name: 'system.nightly',
      schema: z.object({}).default({}),
      repeat: { pattern: '20 3 * * *' },
      handler: async () => {},
    });
    await syncRepeatables(queue, indexJobs([nightly]), logger);
    const [scheduler] = await queue.getJobSchedulers();
    expect(scheduler?.pattern).toBe('20 3 * * *');
    expect(scheduler?.tz).toBe('Asia/Shanghai');
  });
});
