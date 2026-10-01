import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { createAdminSessionStore } from './admin-session.store';

/**
 * Revoking every session of an admin, pinned against a real Redis.
 *
 * The session key slides on every `resolve`, and the per-admin index that
 * `revokeAllForAdmin` reads is given `ttlMs * 4` at `create`. If the index were
 * never slid, a session kept alive past four TTLs would fall out of it, and a
 * password change or a disable would no longer reach it. With the production
 * TTL of 8 h that is anybody who keeps a console tab open for 32 h.
 *
 * The TTL is shrunk to 600 ms so the four-TTL horizon is 2.4 s of wall time
 * (Redis expiry does not follow the harness clock). `resolve` slides the index
 * with the session and re-lists the session in it.
 */

let harness: TestCtx;

const TTL_MS = 600;

const SESSION = {
  adminId: 42,
  account: 'ops',
  name: '运营',
  avatar: null,
  isSuper: false,
  permissions: [],
  passwordVersion: 0,
};

beforeAll(async () => {
  harness = await createTestCtx();
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.redis.flushdb();
});

function store() {
  return createAdminSessionStore({ redis: harness.ctx.redis, ttlMs: TTL_MS });
}

describe('revoking every session of an admin', () => {
  it('reaches a session inside its first four TTLs', async () => {
    const sessions = store();
    const token = await sessions.create(SESSION, 0);
    expect(await sessions.revokeAllForAdmin(SESSION.adminId)).toBe(1);
    expect(await sessions.resolve(token)).toBeNull();
  });

  it('reaches a session that has been kept alive past four TTLs', async () => {
    const sessions = store();
    const token = await sessions.create(SESSION, 0);

    // Somebody keeps working: every request slides the session key.
    for (let elapsed = 0; elapsed < TTL_MS * 5; elapsed += TTL_MS / 4) {
      await sleep(TTL_MS / 4);
      expect(await sessions.resolve(token)).not.toBeNull();
    }

    // The password is changed.
    await sessions.revokeAllForAdmin(SESSION.adminId);

    expect(await sessions.resolve(token)).toBeNull();
  }, 10_000);

  it('re-lists a live session whose index has already expired, so the next revoke reaches it', async () => {
    const sessions = store();
    const token = await sessions.create(SESSION, 0);
    // A session whose index has lapsed.
    await harness.ctx.redis.del(`admin:sess:index:${SESSION.adminId}`);
    expect(await sessions.countFor(SESSION.adminId)).toBe(0);

    expect(await sessions.resolve(token)).not.toBeNull();
    expect(await sessions.countFor(SESSION.adminId)).toBe(1);

    expect(await sessions.revokeAllForAdmin(SESSION.adminId)).toBe(1);
    expect(await sessions.resolve(token)).toBeNull();
    expect(await sessions.countFor(SESSION.adminId)).toBe(0);
  });
});
