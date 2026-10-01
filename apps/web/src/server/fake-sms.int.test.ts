import { codeKey, getSmsSenderOverride, resetSmsSender } from '@shop/core/sms';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildContainer, resetProcessOverrides, setContainer, type Container } from './container';
import type { Env } from './env';

/**
 * `SHOP_FAKE_SMS=1` through the real boot path.
 *
 * The storefront e2e suite runs `next start` in another process, so it cannot
 * `registerSmsSender()` the way an integration test does; it sets this flag
 * and reads the code back out of Redis. This file proves exactly that
 * contract: `buildContainer()` — the function `getContainer()` calls on the
 * first request — with the flag, then `POST /api/v1/auth/sms-codes` succeeds,
 * the code is in Redis under `codeKey(scene, phone)` (what `issueCode()`
 * writes), and it signs the shopper in. Without the flag the same request is
 * the honest `AUTH_SMS_SEND_FAILED` of a shop with no SMS provider.
 */

let harness: TestCtx;
let container: Container | undefined;

const ORIGIN = 'https://shop.example';
const PHONE = '13800138000';

function envFor(flag: Env['SHOP_FAKE_SMS']): Env {
  const redisBase = process.env.SHOP_TEST_REDIS_URL;
  if (!redisBase) throw new Error('SHOP_TEST_REDIS_URL is not set — run through the int project');
  return {
    NODE_ENV: 'production',
    DATABASE_URL: harness.db.url,
    // The harness's own logical database, so `harness.redis` sees what the route wrote.
    REDIS_URL: `${redisBase}/${harness.redis.options.db ?? 0}`,
    UPLOADS_DIR: '/tmp/uploads',
    UPLOADS_PUBLIC_PREFIX: '/uploads',
    APP_ORIGIN: ORIGIN,
    EXTRA_ALLOWED_ORIGINS: [],
    LOG_LEVEL: 'silent',
    LOG_PRETTY: false,
    VALIDATE_RESPONSES: true,
    DB_POOL_MAX: 2,
    QUEUE_NAME: 'shop-fake-sms-test',
    APP_VERSION: 'test',
    ...(flag === undefined ? {} : { SHOP_FAKE_SMS: flag }),
  };
}

function boot(flag: Env['SHOP_FAKE_SMS']): void {
  container = buildContainer(envFor(flag));
  setContainer(container);
}

beforeAll(async () => {
  harness = await createTestCtx({ now: '2026-06-01T00:00:00.000Z' });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
  resetSmsSender();
  resetProcessOverrides();
});

afterEach(async () => {
  setContainer(undefined);
  await container?.close();
  container = undefined;
  resetSmsSender();
  resetProcessOverrides();
});

const json = (path: string, body: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      'x-real-ip': '203.0.113.9',
    },
  });

async function sendCode(): Promise<Response> {
  const { POST } = await import('../../app/api/v1/auth/sms-codes/route');
  return POST(json('/api/v1/auth/sms-codes', { phone: PHONE, scene: 'login' }));
}

describe('SHOP_FAKE_SMS=1', () => {
  it('without the flag a shop with no SMS provider refuses to send', async () => {
    boot(undefined);
    expect(getSmsSenderOverride()).toBeUndefined();

    const response = await sendCode();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'AUTH_SMS_SEND_FAILED' });
    expect(await harness.redis.exists(codeKey('login', PHONE))).toBe(0);
  });

  it('with it, the code is sent, lands in Redis where issueCode() writes it, and signs in', async () => {
    boot('1');
    expect(getSmsSenderOverride()?.name).toBe('fake');

    const response = await sendCode();
    // 202: the contract's answer for "accepted, on its way".
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ expiresInSec: expect.any(Number) });

    // This is what the e2e suite reads: `sms:code:<scene>:<phone>`, field `code`.
    const key = codeKey('login', PHONE);
    expect(key).toBe(`sms:code:login:${PHONE}`);
    const code = await harness.redis.hget(key, 'code');
    expect(code).toMatch(/^\d{6}$/);
    expect(await harness.redis.pttl(key)).toBeGreaterThan(0);

    const { POST: smsLogin } = await import('../../app/api/v1/auth/sessions/sms/route');
    const login = await smsLogin(json('/api/v1/auth/sessions/sms', { phone: PHONE, code }));
    expect(login.status).toBe(201);
    expect(await login.json()).toMatchObject({ token: expect.any(String) });
  });
});
