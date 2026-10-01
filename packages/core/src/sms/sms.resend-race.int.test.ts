import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../kernel/context';
import type { DomainError } from '../kernel/errors';
import { smsConfig } from '../system';
import { fakeSmsSender, registerSmsSender, resetSmsSender, type FakeSmsSender } from './index';
import { sendVerificationCode } from './sms.service';
import { claimResend, releaseResend, resendKey } from './verification-code';

/**
 * The resend guard under a deterministic race (STAB-001).
 *
 * `user.concurrency.int.test.ts > SMS codes > lets one of six sends through
 * the resend guard` only catches a broken guard when the six callers happen to
 * interleave badly on the shared connection. A guard that checked the resend
 * key with `PTTL`, then checked the budgets and read the config, and only then
 * wrote the key with a plain `SET … PX` would be a check followed by a
 * separate write: every caller that read `PTTL` before the first `SET` landed
 * would get through and cost one SMS, up to the per-phone hourly budget (five
 * by default).
 *
 * This file makes the interleaving deterministic. Each caller's first touch of
 * the resend key — a `PTTL` check, or the `SET NX` claim — waits until all six
 * have arrived, which is the schedule a loaded machine produces by chance. Only
 * a guard where the check and the write are one atomic step (`claimResend`:
 * `SET NX PX` first, handed back on a budget or provider refusal) passes.
 */

let harness: TestCtx;
let sms: FakeSmsSender;

const NOW = '2026-06-01T00:00:00.000Z';
const PHONE = '13800138000';
const SCENE = 'login';
const WORKERS = 6;

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
  harness.clock.set(NOW);
  sms = fakeSmsSender();
  registerSmsSender(sms);
  await harness.ctx.config.set(smsConfig, { templateVerifyCode: 'SMS_1' });
});

afterEach(() => {
  resetSmsSender();
});

/**
 * The harness's Redis, except that the first `PTTL` or `SET` on the resend key
 * holds every caller until `parties` of them have reached it. A `PTTL` is
 * answered with what it read before the wait (a check-then-write schedule); a
 * `SET` is sent after it (every claim races at once).
 */
function redisWithResendBarrier(redis: Redis, parties: number): Redis {
  const key = resendKey(SCENE, PHONE);
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const arrive = async () => {
    arrived += 1;
    if (arrived === parties) open();
    await gate;
  };
  return new Proxy(redis, {
    get(target, prop) {
      if (prop === 'pttl') {
        return async (name: string) => {
          const ttl = await target.pttl(name);
          if (name === key && arrived < parties) await arrive();
          return ttl;
        };
      }
      if (prop === 'set') {
        return async (name: string, ...rest: unknown[]) => {
          if (name === key && arrived < parties) await arrive();
          return (target.set as (...a: unknown[]) => Promise<unknown>)(name, ...rest);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

function send(ctx: Ctx) {
  return sendVerificationCode(ctx, {
    scene: SCENE,
    phone: PHONE,
    ttlMs: 300_000,
    resendMs: 60_000,
    perIpPerDay: 100,
  });
}

describe('the resend guard is one atomic claim, not a check then a write', () => {
  it('passes the guard once, sequentially', async () => {
    // The control: without the interleaving, the guard works.
    await send(forkTestCtx(harness));
    await expect(send(forkTestCtx(harness))).rejects.toMatchObject({
      code: 'AUTH_SMS_TOO_FREQUENT',
    });
    expect(sms.sent).toHaveLength(1);
  });

  it('costs one SMS when six taps all read the resend key before any writes it', async () => {
    const redis = redisWithResendBarrier(harness.redis, WORKERS);
    const base = { ...harness, redis } as TestCtx;

    const report = await runConcurrently(WORKERS, (index) =>
      send(forkTestCtx(base, { requestId: `tap-${index}` })),
    );

    expect(sms.sent).toHaveLength(1);
    expect(report.fulfilled).toHaveLength(1);
    for (const failure of report.rejected) {
      expect((failure as DomainError).code).toBe('AUTH_SMS_TOO_FREQUENT');
    }
  });

  it('hands the window back when a budget refuses, so nothing sent means no wait', async () => {
    const refused = sendVerificationCode(forkTestCtx(harness), {
      scene: SCENE,
      phone: PHONE,
      ip: '203.0.113.9',
      ttlMs: 300_000,
      resendMs: 60_000,
      perIpPerDay: 0,
    });
    await expect(refused).rejects.toMatchObject({ code: 'AUTH_SMS_TOO_FREQUENT' });
    expect(await harness.redis.exists(resendKey(SCENE, PHONE))).toBe(0);
    await send(forkTestCtx(harness));
    expect(sms.sent).toHaveLength(1);
  });

  it('hands the window back when the provider refuses', async () => {
    sms.failNext(1);
    await expect(send(forkTestCtx(harness))).rejects.toMatchObject({
      code: 'AUTH_SMS_SEND_FAILED',
    });
    expect(await harness.redis.exists(resendKey(SCENE, PHONE))).toBe(0);
    await send(forkTestCtx(harness));
    expect(sms.sent).toHaveLength(1);
  });

  it('releases only its own claim, never a later caller’s', async () => {
    const first = await claimResend(harness.redis, SCENE, PHONE, 60_000);
    expect(first.waitMs).toBe(0);
    // The first claim expired while its holder was still busy; somebody else claimed.
    await harness.redis.del(resendKey(SCENE, PHONE));
    const second = await claimResend(harness.redis, SCENE, PHONE, 60_000);
    await releaseResend(harness.redis, SCENE, PHONE, first.token!);
    expect(await harness.redis.get(resendKey(SCENE, PHONE))).toBe(second.token);
    const third = await claimResend(harness.redis, SCENE, PHONE, 60_000);
    expect(third.token).toBeNull();
    expect(third.waitMs).toBeGreaterThan(0);
  });
});
