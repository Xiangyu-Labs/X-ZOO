import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { admins } from '@shop/db/schema/auth';
import { AdminAuthService, hashPassword, UserSessionService } from '@shop/core/auth';
import { adminChannel, openAdminStreams } from '@shop/core/notification';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { ADMIN_COOKIE } from '../../../../src/server/handle';
import { setContainer, type Container } from '../../../../src/server/container';
import type { Env } from '../../../../src/server/env';
import { serveAdminNotificationStream, type AdminNotificationStreamOptions } from './_stream';
import { GET } from './route';

/**
 * The bell's SSE stream against a real Redis.
 *
 * 1. It re-checks the session on every keep-alive tick and closes once the
 *    session is revoked — a password change used to leave an open stream
 *    forwarding the admin's notifications for as long as the tab stayed open.
 * 2. Every stream in the process shares one subscriber connection, and one
 *    admin may hold only so many streams.
 *
 * The keep-alive is shortened to 100 ms through the factory the route uses.
 */

let harness: TestCtx;
let container: Container;
let auth: AdminAuthService;

const PASSWORD = 'xzoo123456';
const KEEPALIVE_MS = 100;

const env: Env = {
  NODE_ENV: 'test',
  DATABASE_URL: 'unused',
  REDIS_URL: 'unused',
  UPLOADS_DIR: '/tmp/uploads',
  UPLOADS_PUBLIC_PREFIX: '/uploads',
  APP_ORIGIN: 'https://shop.example',
  EXTRA_ALLOWED_ORIGINS: [],
  LOG_LEVEL: 'silent',
  LOG_PRETTY: false,
  VALIDATE_RESPONSES: true,
  DB_POOL_MAX: 5,
  QUEUE_NAME: 'shop',
  APP_VERSION: 'test',
};

beforeAll(async () => {
  harness = await createTestCtx();
  auth = new AdminAuthService(harness.ctx, { bcryptCost: 4 });
  container = {
    env,
    dbHandle: harness.db.handle,
    db: harness.ctx.db,
    redis: harness.redis,
    clock: harness.clock,
    logger: harness.ctx.logger,
    queue: harness.ctx.queue,
    storage: harness.ctx.storage,
    config: harness.ctx.config,
    adminAuth: auth,
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

async function signIn(): Promise<{ adminId: number; token: string }> {
  const [admin] = await harness.ctx.db
    .insert(admins)
    .values({
      account: 'admin',
      passwordHash: await hashPassword(PASSWORD, 4),
      name: '超级管理员',
      isSuper: true,
    })
    .returning({ id: admins.id });
  const { token } = await auth.login(harness.ctx, { account: 'admin', password: PASSWORD });
  return { adminId: admin!.id, token };
}

interface OpenStream {
  response: Response;
  abort: AbortController;
  /** Everything read so far, decoded. */
  text: () => string;
  /** Resolves when the server ends the body. */
  ended: Promise<void>;
}

/** Connects the way `route.ts` does — resolve the cookie, then serve — with a short tick. */
async function open(
  token: string,
  options: AdminNotificationStreamOptions = { keepaliveMs: KEEPALIVE_MS },
): Promise<OpenStream> {
  const abort = new AbortController();
  const request = new Request('https://shop.example/admin-api/notifications/stream', {
    headers: { cookie: `${ADMIN_COOKIE}=${token}` },
    signal: abort.signal,
  });
  const session = await auth.resolve(token);
  const response = await serveAdminNotificationStream(
    request,
    session ? { token, adminId: session.adminId } : null,
    options,
  );
  let seen = '';
  const decoder = new TextDecoder();
  const ended = (async () => {
    if (!response.body) return;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      seen += decoder.decode(value);
    }
  })();
  return { response, abort, text: () => seen, ended };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` passes or `timeoutMs` runs out — a loaded box delays timers and Pub/Sub. */
async function eventually(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(25);
  }
}

async function subscriberConnections(): Promise<number> {
  const list = (await harness.redis.client('LIST')) as string;
  return list.split('\n').filter((line) => /\bsub=[1-9]/.test(line)).length;
}

describe('the admin notification stream', () => {
  it('forwards a push as a named event, and keeps the stream alive while the session resolves', async () => {
    const { adminId, token } = await signIn();
    const stream = await open(token);
    expect(stream.response.status).toBe(200);

    await harness.redis.publish(adminChannel(adminId), '{"id":"1"}');
    await eventually(
      () => stream.text().includes(': keepalive') && stream.text().includes('"id":"1"'),
    );

    expect(stream.text()).toContain('event: notification\ndata: {"id":"1"}\n\n');
    stream.abort.abort();
    await stream.ended.catch(() => undefined);
  });

  it('closes the stream on the next tick once every session of the admin is revoked', async () => {
    const { adminId, token } = await signIn();
    const stream = await open(token);
    await sleep(KEEPALIVE_MS * 2);

    // The password is changed: every session goes.
    await auth.revokeAll(adminId);

    const outcome = await Promise.race([
      stream.ended.then(() => 'closed'),
      sleep(KEEPALIVE_MS * 30).then(() => 'still open'),
    ]);
    expect(outcome).toBe('closed');

    // And nothing pushed afterwards reaches it: the channel is released.
    expect(openAdminStreams(harness.redis, adminId)).toBe(0);
  });

  it('does not slide the session: an open tab does not keep an idle admin signed in', async () => {
    const { token } = await signIn();
    // Connecting is an ordinary request and slides the session once …
    const stream = await open(token);
    const key = (await harness.redis.keys('admin:sess:*')).find((k) => !k.includes(':index:'))!;
    await harness.redis.pexpire(key, 60_000);
    // … the keep-alive checks after it do not.
    await eventually(() => stream.text().split(': keepalive').length > 3);
    expect(await harness.redis.pttl(key)).toBeLessThanOrEqual(60_000);
    stream.abort.abort();
    await stream.ended.catch(() => undefined);
  });

  it('serves every stream in the process from one subscriber connection', async () => {
    const { adminId, token } = await signIn();
    const before = await subscriberConnections();
    const streams = await Promise.all([open(token), open(token), open(token)]);
    expect(streams.map((s) => s.response.status)).toEqual([200, 200, 200]);
    expect(openAdminStreams(harness.redis, adminId)).toBe(3);
    expect((await subscriberConnections()) - before).toBe(1);

    await harness.redis.publish(adminChannel(adminId), '{"id":"2"}');
    await eventually(() => streams.every((stream) => stream.text().includes('data: {"id":"2"}')));

    for (const stream of streams) stream.abort.abort();
    await Promise.all(streams.map((s) => s.ended.catch(() => undefined)));
    await eventually(() => openAdminStreams(harness.redis, adminId) === 0);
    await eventually(async () => (await subscriberConnections()) === before);
  });

  it('refuses a stream beyond the per-admin cap with 429', async () => {
    const { token } = await signIn();
    const capped = { keepaliveMs: KEEPALIVE_MS, maxPerAdmin: 2 };
    const first = await open(token, capped);
    const second = await open(token, capped);
    const third = await open(token, capped);
    expect([first, second, third].map((s) => s.response.status)).toEqual([200, 200, 429]);
    await third.ended;
    expect(JSON.parse(third.text())).toMatchObject({ code: 'RATE_LIMITED' });
    for (const stream of [first, second]) stream.abort.abort();
    await Promise.all([first, second].map((s) => s.ended.catch(() => undefined)));
  });

  it('401s through the route without a cookie, and with a revoked one', async () => {
    const bare = await GET(new Request('https://shop.example/admin-api/notifications/stream'));
    expect(bare.status).toBe(401);

    const { adminId, token } = await signIn();
    await auth.revokeAll(adminId);
    const revoked = await GET(
      new Request('https://shop.example/admin-api/notifications/stream', {
        headers: { cookie: `${ADMIN_COOKIE}=${token}` },
      }),
    );
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
