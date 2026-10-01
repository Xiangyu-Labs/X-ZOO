import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { createBullQueue, toJobId } from './queue-bullmq';

/**
 * The real adapter against a real Redis — the one place `dedupeKey` meets
 * BullMQ's `jobId` rules. Every other suite runs on `memoryQueue()`, which
 * accepts any string, so only this suite hands BullMQ a `name:id` key before
 * the e2e suites do.
 */

let harness: TestCtx;
let queue: ReturnType<typeof createBullQueue>;

beforeAll(async () => {
  harness = await createTestCtx();
  queue = createBullQueue({ connection: harness.redis, queueName: 'kernel-test' });
}, 180_000);

afterAll(async () => {
  await queue?.close();
  await harness?.close();
});

beforeEach(async () => {
  await harness.redis.flushdb();
});

describe('toJobId', () => {
  it('turns the producers’ `name:id` keys into ids BullMQ accepts', () => {
    expect(toJobId('order-auto-cancel:42')).toBe('order-auto-cancel__42');
    expect(toJobId('a:b:c')).toBe('a__b__c');
    expect(toJobId('plain')).toBe('plain');
  });

  it('never yields an integer id, which BullMQ also refuses', () => {
    expect(toJobId('123')).toBe('k__123');
  });
});

describe('createBullQueue', () => {
  it('enqueues a job whose dedupeKey carries a colon', async () => {
    await expect(
      queue.enqueue(
        'order.autoCancel',
        { orderId: '1' },
        { delay: 60_000, dedupeKey: 'order-auto-cancel:1' },
      ),
    ).resolves.toBeUndefined();
  });

  it('treats a second enqueue under the same dedupeKey as a no-op', async () => {
    const key = 'order-auto-receive:7';
    await queue.enqueue(
      'order.autoReceive',
      { orderId: '7', try: 1 },
      { delay: 60_000, dedupeKey: key },
    );
    await queue.enqueue(
      'order.autoReceive',
      { orderId: '7', try: 2 },
      { delay: 60_000, dedupeKey: key },
    );

    const delayed = await harness.redis.zcard('bull:kernel-test:delayed');
    expect(delayed).toBe(1);
    const stored = await harness.redis.hget(`bull:kernel-test:${toJobId(key)}`, 'data');
    expect(JSON.parse(stored ?? '{}')).toEqual({ orderId: '7', try: 1 });
  });

  it('cancels by the same key it enqueued under', async () => {
    const key = 'order-complete:9';
    await queue.enqueue('order.complete', { orderId: '9' }, { delay: 60_000, dedupeKey: key });
    expect(await harness.redis.zcard('bull:kernel-test:delayed')).toBe(1);

    await queue.cancel(key);
    expect(await harness.redis.zcard('bull:kernel-test:delayed')).toBe(0);
    expect(await harness.redis.exists(`bull:kernel-test:${toJobId(key)}`)).toBe(0);
  });
});
