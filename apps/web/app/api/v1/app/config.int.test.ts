import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminAuthService, UserSessionService } from '@shop/core/auth';
import type { AppPublicConfig } from '@shop/contracts/system/app.schemas';
import { configSave } from '@shop/core/system';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { setContainer, type Container } from '../../../../src/server/container';
import type { Env } from '../../../../src/server/env';

/**
 * `GET /api/v1/app/config` answering `If-None-Match` (SYS-016 over HTTP).
 *
 * The mini-program's first request of every launch, so a caller holding the
 * current version gets a bodyless 304, and a save through the settings screen
 * moves the tag at once, whichever source group it lands in. It also proves the
 * route is public and that its response passes the contract's validation
 * (`VALIDATE_RESPONSES: true`).
 */

let harness: TestCtx;

const ORIGIN = 'https://shop.example';

const env: Env = {
  NODE_ENV: 'test',
  DATABASE_URL: 'unused',
  REDIS_URL: 'unused',
  UPLOADS_DIR: '/tmp/uploads',
  UPLOADS_PUBLIC_PREFIX: '/uploads',
  APP_ORIGIN: ORIGIN,
  EXTRA_ALLOWED_ORIGINS: [],
  LOG_LEVEL: 'silent',
  LOG_PRETTY: false,
  VALIDATE_RESPONSES: true,
  DB_POOL_MAX: 5,
  QUEUE_NAME: 'shop',
  APP_VERSION: 'test',
};

beforeAll(async () => {
  harness = await createTestCtx({ now: '2026-06-01T00:00:00.000Z', platform: 'h5' });
  const container: Container = {
    env,
    dbHandle: harness.db.handle,
    db: harness.ctx.db,
    redis: harness.redis,
    clock: harness.clock,
    logger: harness.ctx.logger,
    queue: harness.ctx.queue,
    storage: harness.ctx.storage,
    config: harness.ctx.config,
    adminAuth: new AdminAuthService(harness.ctx, { bcryptCost: 4 }),
    userSessions: new UserSessionService(),
    close: async () => {},
  };
  setContainer(container);
}, 180_000);

afterAll(async () => {
  setContainer(undefined);
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
});

async function read(headers: Record<string, string> = {}) {
  const { GET } = await import('./config/route');
  return GET(new Request(`${ORIGIN}/api/v1/app/config`, { headers }));
}

describe('GET /api/v1/app/config — conditional', () => {
  it('sends the settings and their weak tag to a caller that has nothing', async () => {
    const response = await read();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { version: string };
    expect(response.headers.get('etag')).toBe(`W/"${body.version}"`);
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('answers a caller holding the current version with a bodyless 304', async () => {
    const tag = (await read()).headers.get('etag')!;

    for (const offered of [tag, tag.replace(/^W\//, '')]) {
      const response = await read({ 'if-none-match': offered });
      expect(response.status, offered).toBe(304);
      expect(await response.text()).toBe('');
      expect(response.headers.get('etag')).toBe(tag);
    }
  });

  it.each([
    ['site', { siteName: '新店名' }],
    ['wechat-mini', { contactPhone: '13800000000' }],
    ['storefront-appearance', { primaryColor: '#1677FF' }],
    ['wechat-oa-runtime', { subscribeOrderShip: 'tmpl-ship' }],
  ] as const)('sends the new settings once the %s group is saved', async (group, values) => {
    const tag = (await read()).headers.get('etag')!;

    harness.clock.advance(1_000);
    await configSave(harness.ctx, { group }, { values });

    const response = await read({ 'if-none-match': tag });
    expect(response.status).toBe(200);
    const fresh = response.headers.get('etag');
    expect(fresh).not.toBe(tag);
    const body = (await response.json()) as AppPublicConfig;
    expect(fresh).toBe(`W/"${body.version}"`);
    if (group === 'site') expect(body.name).toBe('新店名');
    if (group === 'storefront-appearance') {
      expect(body.appearance.theme.primaryColor).toBe('#1677FF');
    }
    if (group === 'wechat-oa-runtime') {
      expect(body.subscribeTemplates.orderShip).toEqual(['tmpl-ship']);
    }

    expect((await read({ 'if-none-match': fresh! })).status).toBe(304);
  });
});

describe('SYS-015 — the product poster switch over HTTP', () => {
  it('offers the poster on a fresh install and stops once the operator switches it off', async () => {
    const before = (await (await read()).json()) as AppPublicConfig;
    expect(before.display.productPoster).toBe(true);

    harness.clock.advance(1_000);
    await configSave(
      harness.ctx,
      { group: 'storefront-appearance' },
      { values: { showProductPoster: false } },
    );

    const after = (await (await read()).json()) as AppPublicConfig;
    expect(after.display).toEqual({ ...before.display, productPoster: false });
    expect(after.version).not.toBe(before.version);
  });
});

describe('SYS-017 — the server clock rides outside the ETag', () => {
  it('stamps every answer with the server time, in the body and the X-Server-Time header', async () => {
    const response = await read();
    const body = (await response.json()) as AppPublicConfig;
    expect(body.serverTime).toBe(harness.clock.now().toISOString());
    expect(response.headers.get('x-server-time')).toBe(body.serverTime);
  });

  it('keeps answering 304 as the clock moves, and the 304 still carries the time', async () => {
    const first = await read();
    const tag = first.headers.get('etag')!;

    harness.clock.advance(90_000);
    const response = await read({ 'if-none-match': tag });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
    expect(response.headers.get('etag')).toBe(tag);
    expect(response.headers.get('x-server-time')).toBe(harness.clock.now().toISOString());
  });
});
