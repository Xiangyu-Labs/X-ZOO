import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminAuthService, UserSessionService } from '@shop/core/auth';
import { recordEffect } from '@shop/core/effects';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { GET as readyz } from '../../app/api/v1/readyz/route';
import { setContainer, type Container } from './container';
import type { Env } from './env';
import { EXPECTED_MIGRATIONS } from './health';

/**
 * `/api/v1/readyz` against a real PostgreSQL and Redis.
 *
 * The point of the endpoint is that it tells the truth about the things a
 * release is gated on, and that it says nothing else — so both halves are
 * asserted here: four `ok` when the stack is whole, and a 503 that names
 * exactly one failed dependency and carries no error text, host or credential.
 */

let harness: TestCtx;

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

/**
 * The test harness applies the migration SQL directly rather than through
 * drizzle's migrator (`packages/testing/src/harness/global-setup.ts`), so the
 * bookkeeping table the migrator maintains does not exist here. The readiness
 * check reads exactly that table, so the test has to stand in for the migrator
 * — which also makes "the schema was never migrated" a state it can produce.
 */
async function recordMigrations(applied: number): Promise<void> {
  await harness.ctx.db.execute('create schema if not exists drizzle');
  await harness.ctx.db.execute(`create table if not exists drizzle.__drizzle_migrations (
      id serial primary key,
      hash text not null,
      created_at bigint
    )`);
  await harness.ctx.db.execute('delete from drizzle.__drizzle_migrations');
  for (let index = 0; index < applied; index += 1) {
    await harness.ctx.db.execute(
      `insert into drizzle.__drizzle_migrations (hash, created_at)
       values ('fake-${String(index)}', 0)`,
    );
  }
}

/**
 * What a working worker leaves: the loop beat it writes every
 * `HEARTBEAT_INTERVAL_MS`, and the beat it writes when a job completes.
 */
async function beat(): Promise<void> {
  await harness.redis.set('worker:heartbeat', String(harness.clock.nowMs()));
  await harness.redis.set('worker:heartbeat:job', String(harness.clock.nowMs()));
}

async function readyzResponse(): Promise<{ status: number; body: unknown }> {
  const response = await readyz(new Request('http://edge.test/api/v1/readyz'));
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  harness = await createTestCtx();
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
    // Unused: the route is `auth: 'public'` by contract, because the caller is
    // a probe and has no session. They are real instances anyway, so the test
    // container is the production shape rather than a shape that only works
    // while nothing looks at it.
    adminAuth: new AdminAuthService(harness.ctx),
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
  await harness.redis.flushdb();
  await recordMigrations(EXPECTED_MIGRATIONS);
  await beat();
});

describe('GET /api/v1/readyz', () => {
  it('is 200 with every check ok when the stack is whole', async () => {
    const { status, body } = await readyzResponse();

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      // `APP_VERSION` is read from the process, exactly as `healthPayload`
      // reads it: the build marker belongs to the image, not to the container
      // a test happens to assemble.
      version: 'dev',
      checks: { database: 'ok', redis: 'ok', migrations: 'ok', worker: 'ok' },
    });
  });

  it('reports the effects backlog as a detail, never as a failing check', async () => {
    await harness.db.truncateAll();
    const empty = await readyzResponse();
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ backlog: { effectsOldestDueSeconds: null } });

    // A row that has been due for 90 s and nobody has picked up: late, and
    // still ready — a slow notification is not a reason to hold a release.
    await harness.ctx.withTx((tx) =>
      recordEffect(tx, harness.ctx, {
        scope: 'order',
        scopeId: 'readyz-backlog',
        eventType: 'order.paid',
        payload: {},
      }),
    );
    harness.clock.advance(90_000);
    await beat();

    const late = await readyzResponse();
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({
      checks: { database: 'ok', redis: 'ok', migrations: 'ok', worker: 'ok' },
      backlog: { effectsOldestDueSeconds: 90 },
    });
    await harness.db.truncateAll();
  });

  it('is 503 naming only the worker when the heartbeat stops', async () => {
    // Exactly what a drained or wedged worker leaves behind: the key is
    // deleted before draining on SIGTERM, and expires on a loop that stops
    // beating.
    await harness.redis.del('worker:heartbeat');

    const { status, body } = await readyzResponse();

    expect(status).toBe(503);
    // The whole body, asserted exactly: a probe is reachable by anyone who can
    // reach the site, so an error string, a host or a connection detail
    // leaking in here would be leaking to all of them.
    expect(body).toEqual({
      code: 'HEALTH_NOT_READY',
      message: '服务尚未就绪',
      details: { checks: { database: 'ok', redis: 'ok', migrations: 'ok', worker: 'failed' } },
    });
  });

  it('is 503 when a heartbeat is present but stale', async () => {
    // Present, parseable, and older than three beats. `EXISTS` would call this
    // worker healthy for as long as the key's TTL lasts.
    await harness.redis.set('worker:heartbeat', String(harness.clock.nowMs() - 10 * 60 * 1000));

    const { status, body } = await readyzResponse();

    expect(status).toBe(503);
    expect(body).toMatchObject({ details: { checks: { worker: 'failed' } } });
  });

  it('OPS-017 — is 503 when the process beats but no job has completed for minutes', async () => {
    // The loop beat is a timer: it keeps ticking while BullMQ's consumer is
    // stuck. Only the completed-job beat says the queue is being consumed.
    await harness.redis.set('worker:heartbeat:job', String(harness.clock.nowMs() - 10 * 60 * 1000));

    const { status, body } = await readyzResponse();

    expect(status).toBe(503);
    expect(body).toMatchObject({ details: { checks: { worker: 'failed' } } });
  });

  it('OPS-017 — is 503 when no job has ever completed', async () => {
    await harness.redis.del('worker:heartbeat:job');

    const { status, body } = await readyzResponse();

    expect(status).toBe(503);
    expect(body).toMatchObject({ details: { checks: { worker: 'failed' } } });
  });

  it('is 503 when the database was created but never migrated', async () => {
    await recordMigrations(0);

    const { status, body } = await readyzResponse();

    expect(status).toBe(503);
    expect(body).toMatchObject({
      details: { checks: { database: 'ok', redis: 'ok', migrations: 'failed', worker: 'ok' } },
    });
  });

  it('logs its 503 at info, not error', async () => {
    // The readiness gate polls this endpoint on every deploy, so a stack that
    // takes forty seconds to come up answers 503 forty times on its way to
    // serving. At `error` those forty lines describe nothing wrong and bury the
    // one that does, in the window where somebody is deciding whether to roll
    // back. `health.readiness` declares `expectedStatuses: [503]` and the
    // binder honours it; this asserts the two halves are actually wired to each
    // other, which neither the contract nor `handle.test.ts` can say alone.
    await harness.redis.del('worker:heartbeat');
    const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const spy = vi.spyOn(harness.ctx.logger, 'child').mockReturnValue(child as never);

    try {
      const { status } = await readyzResponse();

      expect(status).toBe(503);
      expect(child.info).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/api/v1/readyz', status: 503 }),
        'request',
      );
      expect(child.error).not.toHaveBeenCalled();
      expect(child.warn).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('is ready against a schema newer than the build expects', async () => {
    // The rollback case OPS-007 depends on: the previous image runs in front of
    // the newer schema, migrations are additive, and that stack serves.
    await recordMigrations(EXPECTED_MIGRATIONS + 3);

    const { status } = await readyzResponse();

    expect(status).toBe(200);
  });
});
