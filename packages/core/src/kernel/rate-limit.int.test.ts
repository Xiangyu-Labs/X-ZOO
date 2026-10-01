import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
import { type DomainError } from './errors';
import { enforce, fixedWindow, resetFixedWindow, tokenBucket } from './rate-limit';

let harness: TestCtx;

beforeAll(async () => {
  harness = await createTestCtx();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.redis.flushdb();
});

describe('fixedWindow', () => {
  const options = { key: 'test:fixed', limit: 3, windowMs: 60_000 };

  it('allows up to the limit and then refuses', async () => {
    const now = harness.clock.nowMs();
    for (let i = 0; i < 3; i += 1) {
      const result = await fixedWindow(harness.redis, { ...options, nowMs: now });
      expect(result.allowed, `attempt ${i}`).toBe(true);
      expect(result.remaining).toBe(2 - i);
    }
    const refused = await fixedWindow(harness.redis, { ...options, nowMs: now });
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.resetAt).toBeGreaterThan(now);
  });

  it('sets the TTL once, on the first call in a window', async () => {
    const now = harness.clock.nowMs();
    await fixedWindow(harness.redis, { ...options, nowMs: now });
    const first = await harness.redis.pttl(options.key);
    await fixedWindow(harness.redis, { ...options, nowMs: now });
    const second = await harness.redis.pttl(options.key);
    // The second call must not extend the window — otherwise a busy attacker
    // holds it open forever.
    expect(second).toBeLessThanOrEqual(first);
    expect(first).toBeGreaterThan(50_000);
  });

  it('counts atomically under concurrency — exactly `limit` get through', async () => {
    const now = harness.clock.nowMs();
    const report = await runConcurrently(
      50,
      () =>
        fixedWindow(harness.redis, { key: 'test:race', limit: 10, windowMs: 60_000, nowMs: now }),
      { isWinner: (result) => result.allowed },
    );
    expect(report.rejected).toEqual([]);
    expect(report.winners).toBe(10);
    expect(report.losers).toBe(40);
  });

  it('keys are independent', async () => {
    const now = harness.clock.nowMs();
    for (let i = 0; i < 3; i += 1) {
      await fixedWindow(harness.redis, { ...options, nowMs: now });
    }
    const other = await fixedWindow(harness.redis, { ...options, key: 'test:other', nowMs: now });
    expect(other.allowed).toBe(true);
  });

  it('resetFixedWindow forgets the counter', async () => {
    const now = harness.clock.nowMs();
    for (let i = 0; i < 4; i += 1) await fixedWindow(harness.redis, { ...options, nowMs: now });
    await resetFixedWindow(harness.redis, options.key);
    expect((await fixedWindow(harness.redis, { ...options, nowMs: now })).allowed).toBe(true);
  });

  it('the window really does expire', async () => {
    const now = harness.clock.nowMs();
    const short = { key: 'test:short', limit: 1, windowMs: 200 };
    expect((await fixedWindow(harness.redis, { ...short, nowMs: now })).allowed).toBe(true);
    expect((await fixedWindow(harness.redis, { ...short, nowMs: now })).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await fixedWindow(harness.redis, { ...short, nowMs: now })).allowed).toBe(true);
  });
});

describe('tokenBucket', () => {
  const bucket = { key: 'test:bucket', capacity: 3, refillPerSec: 1 };

  it('allows a burst up to the capacity', async () => {
    const now = harness.clock.nowMs();
    for (let i = 0; i < 3; i += 1) {
      expect((await tokenBucket(harness.redis, { ...bucket, nowMs: now })).allowed).toBe(true);
    }
    const refused = await tokenBucket(harness.redis, { ...bucket, nowMs: now });
    expect(refused.allowed).toBe(false);
    // One token per second, so about a second to wait.
    expect(refused.retryAfterMs).toBeGreaterThan(900);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it('refills over time', async () => {
    const now = harness.clock.nowMs();
    for (let i = 0; i < 3; i += 1) await tokenBucket(harness.redis, { ...bucket, nowMs: now });
    expect((await tokenBucket(harness.redis, { ...bucket, nowMs: now })).allowed).toBe(false);

    // Two seconds later, two tokens are back.
    const later = now + 2000;
    expect((await tokenBucket(harness.redis, { ...bucket, nowMs: later })).allowed).toBe(true);
    expect((await tokenBucket(harness.redis, { ...bucket, nowMs: later })).allowed).toBe(true);
    expect((await tokenBucket(harness.redis, { ...bucket, nowMs: later })).allowed).toBe(false);
  });

  it('never refills past the capacity', async () => {
    const now = harness.clock.nowMs();
    await tokenBucket(harness.redis, { ...bucket, nowMs: now });
    // An hour later the bucket is full, not overflowing.
    const result = await tokenBucket(harness.redis, { ...bucket, nowMs: now + 3_600_000 });
    expect(result.remaining).toBe(2);
  });

  it('honours a cost greater than one', async () => {
    const now = harness.clock.nowMs();
    expect((await tokenBucket(harness.redis, { ...bucket, nowMs: now, cost: 3 })).allowed).toBe(
      true,
    );
    expect((await tokenBucket(harness.redis, { ...bucket, nowMs: now, cost: 1 })).allowed).toBe(
      false,
    );
  });

  it('is atomic under concurrency', async () => {
    const now = harness.clock.nowMs();
    const report = await runConcurrently(
      30,
      () =>
        tokenBucket(harness.redis, {
          key: 'test:bucket-race',
          capacity: 5,
          refillPerSec: 1,
          nowMs: now,
        }),
      { isWinner: (result) => result.allowed },
    );
    expect(report.rejected).toEqual([]);
    expect(report.winners).toBe(5);
  });

  it('rejects a nonsensical refill rate', async () => {
    await expect(
      tokenBucket(harness.redis, { ...bucket, refillPerSec: 0, nowMs: 0 }),
    ).rejects.toThrow(RangeError);
  });
});

describe('enforce', () => {
  it('passes a permitted call through', async () => {
    const result = await enforce(
      fixedWindow(harness.redis, {
        key: 'test:enforce',
        limit: 1,
        windowMs: 1000,
        nowMs: harness.clock.nowMs(),
      }),
    );
    expect(result.allowed).toBe(true);
  });

  it('throws RATE_LIMITED with a retry hint', async () => {
    const options = {
      key: 'test:enforce-2',
      limit: 1,
      windowMs: 60_000,
      nowMs: harness.clock.nowMs(),
    };
    await enforce(fixedWindow(harness.redis, options));
    const error = await enforce(fixedWindow(harness.redis, options)).catch((e: DomainError) => e);
    expect((error as DomainError).code).toBe('RATE_LIMITED');
    expect((error as DomainError).status).toBe(429);
    expect((error as DomainError).details).toMatchObject({ retryAfterMs: expect.any(Number) });
  });

  it('can raise a domain-specific code instead', async () => {
    const options = {
      key: 'test:enforce-3',
      limit: 0,
      windowMs: 60_000,
      nowMs: harness.clock.nowMs(),
    };
    const error = await enforce(
      fixedWindow(harness.redis, options),
      'AUTH_TOO_MANY_ATTEMPTS',
    ).catch((e: DomainError) => e);
    expect((error as DomainError).code).toBe('AUTH_TOO_MANY_ATTEMPTS');
    expect((error as DomainError).status).toBe(429);
  });
});
