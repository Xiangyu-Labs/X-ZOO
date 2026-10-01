import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { admins, adminRoles, rolePermissions, roles, userSessions } from '@shop/db/schema/auth';
import { users } from '@shop/db/schema/user';
import {
  createTestCtx,
  fakeCaptchaVerifier,
  fakeUserLookup,
  runConcurrently,
  type TestCtx,
} from '@shop/testing';
import { type DomainError } from '../kernel/errors';
import { registerCaptchaVerifier, resetCaptchaVerifier } from './captcha';
import { AdminAuthService } from './admin-auth.service';
import { IMPLICIT_ADMIN_PERMISSIONS } from './rbac';
import { hashPassword, sha256Hex } from './password';
import { registerUserLookup, resetUserLookup } from './user-lookup';
import { UserSessionService } from './user-session.service';

let harness: TestCtx;
let auth: AdminAuthService;

const PASSWORD = 'xzoo123456';
const BCRYPT_COST = 4; // pure-JS bcrypt: cost 10 would add ~15s to this file

beforeAll(async () => {
  harness = await createTestCtx();
  auth = new AdminAuthService(harness.ctx, { bcryptCost: BCRYPT_COST });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
  resetCaptchaVerifier();
  resetUserLookup();
});

afterEach(() => {
  resetCaptchaVerifier();
  resetUserLookup();
});

async function seedAdmin(
  over: { account?: string; isSuper?: boolean; status?: number; hash?: string; algo?: string } = {},
): Promise<number> {
  const rows = await harness.ctx.db
    .insert(admins)
    .values({
      account: over.account ?? 'admin',
      passwordHash: over.hash ?? (await hashPassword(PASSWORD, BCRYPT_COST)),
      passwordAlgo: over.algo ?? 'bcrypt',
      name: '超级管理员',
      isSuper: over.isSuper ?? false,
      status: over.status ?? 1,
    })
    .returning({ id: admins.id });
  return rows[0]!.id;
}

async function grant(adminId: number, permissions: string[]): Promise<void> {
  const [role] = await harness.ctx.db
    .insert(roles)
    .values({ name: `role-${adminId}` })
    .returning({ id: roles.id });
  await harness.ctx.db.insert(adminRoles).values({ adminId, roleId: role!.id });
  await harness.ctx.db
    .insert(rolePermissions)
    .values(permissions.map((permission) => ({ roleId: role!.id, permission })));
}

describe('admin login', () => {
  it('returns a session token and the profile', async () => {
    const id = await seedAdmin({ isSuper: true });
    const result = await auth.login(harness.ctx, { account: 'admin', password: PASSWORD });

    expect(result.token).toMatch(/^[a-z2-9]{40}$/);
    expect(result.profile).toMatchObject({
      id: String(id),
      account: 'admin',
      isSuper: true,
    });
    expect(result.profile.permissions).toEqual([...IMPLICIT_ADMIN_PERMISSIONS].sort());

    const [row] = await harness.ctx.db.select().from(admins).where(eq(admins.id, id));
    expect(row?.lastLoginAt?.getTime()).toBe(harness.clock.nowMs());
  });

  it('finds the account case-insensitively', async () => {
    await seedAdmin({ account: 'Admin' });
    await expect(
      auth.login(harness.ctx, { account: 'ADMIN', password: PASSWORD }),
    ).resolves.toBeDefined();
  });

  it('loads granted permissions for a non-super admin', async () => {
    const id = await seedAdmin();
    await grant(id, ['catalog:product:read', 'catalog:product:update']);
    const result = await auth.login(harness.ctx, { account: 'admin', password: PASSWORD });
    expect(result.profile.permissions).toEqual(
      [...IMPLICIT_ADMIN_PERMISSIONS, 'catalog:product:read', 'catalog:product:update'].sort(),
    );
  });

  it('gives the same error for a wrong password and an unknown account', async () => {
    await seedAdmin();
    const wrongPassword = await auth
      .login(harness.ctx, { account: 'admin', password: 'nope' })
      .catch((e: DomainError) => e);
    const unknownAccount = await auth
      .login(harness.ctx, { account: 'nobody', password: PASSWORD })
      .catch((e: DomainError) => e);
    expect((wrongPassword as DomainError).code).toBe('AUTH_INVALID_CREDENTIALS');
    expect((unknownAccount as DomainError).code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('refuses a disabled account, but only once the password is right', async () => {
    await seedAdmin({ status: 0 });
    await expect(
      auth.login(harness.ctx, { account: 'admin', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_DISABLED' });
    // A wrong password on a disabled account must not reveal that it exists.
    await expect(
      auth.login(harness.ctx, { account: 'admin', password: 'nope' }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
  });

  it('upgrades a legacy md5 hash to bcrypt on the first good login', async () => {
    const md5 = createHash('md5').update(PASSWORD).digest('hex');
    const id = await seedAdmin({ hash: md5, algo: 'md5' });

    await expect(
      auth.login(harness.ctx, { account: 'admin', password: PASSWORD }),
    ).resolves.toBeDefined();

    const [row] = await harness.ctx.db.select().from(admins).where(eq(admins.id, id));
    expect(row?.passwordAlgo).toBe('bcrypt');
    expect(row?.passwordHash.startsWith('$2')).toBe(true);

    // And the upgraded hash still works.
    await expect(
      auth.login(harness.ctx, { account: 'admin', password: PASSWORD }),
    ).resolves.toBeDefined();
  });
});

describe('the per-account login throttle', () => {
  it('parks the account after the fifth wrong password', async () => {
    await seedAdmin();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        auth.login(harness.ctx, { account: 'admin', password: 'nope' }),
      ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    }
    const parked = await auth
      .login(harness.ctx, { account: 'admin', password: PASSWORD })
      .catch((e: DomainError) => e);
    expect((parked as DomainError).code).toBe('AUTH_TOO_MANY_ATTEMPTS');
    expect((parked as DomainError).details).toMatchObject({ retryAfterMs: expect.any(Number) });
  });

  it('is keyed by account, so one account cannot lock another out', async () => {
    await seedAdmin({ account: 'admin' });
    await seedAdmin({ account: 'other' });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await auth.login(harness.ctx, { account: 'admin', password: 'nope' }).catch(() => undefined);
    }
    await expect(
      auth.login(harness.ctx, { account: 'other', password: PASSWORD }),
    ).resolves.toBeDefined();
  });

  it('clears the counter on a successful login', async () => {
    await seedAdmin();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await auth.login(harness.ctx, { account: 'admin', password: 'nope' }).catch(() => undefined);
    }
    await auth.login(harness.ctx, { account: 'admin', password: PASSWORD });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        auth.login(harness.ctx, { account: 'admin', password: 'nope' }),
      ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    }
  });

  it('counts concurrent attempts atomically — five wrong passwords is five', async () => {
    await seedAdmin();
    const report = await runConcurrently(10, () =>
      auth
        .login(harness.ctx, { account: 'admin', password: 'nope' })
        .catch((e: DomainError) => e.code),
    );
    const codes = report.fulfilled as string[];
    expect(codes.filter((c) => c === 'AUTH_INVALID_CREDENTIALS')).toHaveLength(5);
    expect(codes.filter((c) => c === 'AUTH_TOO_MANY_ATTEMPTS')).toHaveLength(5);
  });
});

describe('the throttle when the caller’s address is known', () => {
  const FROM_A = { ip: '203.0.113.1' };
  const FROM_B = { ip: '203.0.113.2' };

  it('parks the guesser, not the account: the admin at another address still gets in', async () => {
    await seedAdmin({ isSuper: true });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await auth
        .login(harness.ctx, { account: 'admin', password: 'nope' }, FROM_A)
        .catch(() => undefined);
    }
    await expect(
      auth.login(harness.ctx, { account: 'admin', password: PASSWORD }, FROM_A),
    ).rejects.toMatchObject({ code: 'AUTH_TOO_MANY_ATTEMPTS' });
    await expect(
      auth.login(harness.ctx, { account: 'admin', password: PASSWORD }, FROM_B),
    ).resolves.toMatchObject({ profile: { account: 'admin' } });
  });

  it('still parks the account once guesses from many addresses add up', async () => {
    const ceilinged = new AdminAuthService(harness.ctx, {
      bcryptCost: BCRYPT_COST,
      accountCeiling: 8,
    });
    await seedAdmin();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await ceilinged
        .login(harness.ctx, { account: 'admin', password: 'nope' }, { ip: `198.51.100.${attempt}` })
        .catch(() => undefined);
    }
    await expect(
      ceilinged.login(harness.ctx, { account: 'admin', password: PASSWORD }, FROM_B),
    ).rejects.toMatchObject({ code: 'AUTH_TOO_MANY_ATTEMPTS' });
  });
});

describe('an unknown account', () => {
  it('costs a bcrypt comparison too, so the answer’s timing does not tell', async () => {
    // Cost 12 makes one comparison ~250ms or more even on a fast machine; a
    // lookup that finds nothing and returns is a few milliseconds.
    const slow = new AdminAuthService(harness.ctx, { bcryptCost: 12 });
    await slow.login(harness.ctx, { account: 'nobody', password: PASSWORD }).catch(() => undefined);

    const started = performance.now();
    await expect(
      slow.login(harness.ctx, { account: 'nobody-else', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    expect(performance.now() - started).toBeGreaterThan(100);
  });
});

describe('the captcha hook', () => {
  it('is skipped while nothing is registered', async () => {
    await seedAdmin();
    await expect(
      auth.login(harness.ctx, { account: 'admin', password: PASSWORD }),
    ).resolves.toBeDefined();
  });

  it('is demanded after the threshold once a verifier is registered', async () => {
    await seedAdmin();
    registerCaptchaVerifier(fakeCaptchaVerifier({ accept: true }));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await auth.login(harness.ctx, { account: 'admin', password: 'nope' }).catch(() => undefined);
    }
    await expect(
      auth.login(harness.ctx, { account: 'admin', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'AUTH_CAPTCHA_REQUIRED' });
    await expect(
      auth.login(harness.ctx, { account: 'admin', password: PASSWORD, captchaToken: 'solved' }),
    ).resolves.toBeDefined();
  });

  it('rejects a token the verifier does not accept', async () => {
    await seedAdmin();
    registerCaptchaVerifier(fakeCaptchaVerifier({ accept: false }));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await auth.login(harness.ctx, { account: 'admin', password: 'nope' }).catch(() => undefined);
    }
    await expect(
      auth.login(harness.ctx, { account: 'admin', password: PASSWORD, captchaToken: 'bad' }),
    ).rejects.toMatchObject({ code: 'AUTH_CAPTCHA_INVALID' });
  });
});

describe('admin sessions', () => {
  it('resolves a token to its session and slides the TTL', async () => {
    const id = await seedAdmin({ isSuper: true });
    const { token } = await auth.login(harness.ctx, { account: 'admin', password: PASSWORD });

    const session = await auth.resolve(token);
    expect(session).toMatchObject({ adminId: id, account: 'admin', isSuper: true });

    const ttl = await harness.redis.pttl(`admin:sess:${sha256Hex(token)}`);
    expect(ttl).toBeGreaterThan(0);
  });

  it('AUTH-011: 记住登录状态 keeps the session seven idle days, otherwise eight hours', async () => {
    await seedAdmin({ isSuper: true });
    const plain = await auth.login(harness.ctx, { account: 'admin', password: PASSWORD });
    expect(plain).toMatchObject({ remember: false, expiresInMs: 8 * 60 * 60 * 1000 });
    const plainTtl = await harness.redis.pttl(`admin:sess:${sha256Hex(plain.token)}`);
    expect(plainTtl).toBeLessThanOrEqual(8 * 60 * 60 * 1000);

    const kept = await auth.login(harness.ctx, {
      account: 'admin',
      password: PASSWORD,
      remember: true,
    });
    expect(kept).toMatchObject({ remember: true, expiresInMs: 7 * 24 * 60 * 60 * 1000 });
    expect(await auth.resolve(kept.token)).toMatchObject({
      remember: true,
      ttlMs: 7 * 24 * 60 * 60 * 1000,
    });
    const keptTtl = await harness.redis.pttl(`admin:sess:${sha256Hex(kept.token)}`);
    expect(keptTtl).toBeGreaterThan(8 * 60 * 60 * 1000);
    // The revoke index outlives the remembered session.
    const indexTtl = await harness.redis.pttl(`admin:sess:index:${kept.profile.id}`);
    expect(indexTtl).toBeGreaterThan(7 * 24 * 60 * 60 * 1000);
  });

  it('stores only the hash of the token', async () => {
    await seedAdmin();
    const { token } = await auth.login(harness.ctx, { account: 'admin', password: PASSWORD });
    const keys = await harness.redis.keys('admin:sess:*');
    expect(keys).toContain(`admin:sess:${sha256Hex(token)}`);
    for (const key of keys) expect(key).not.toContain(token);
  });

  it('returns null for an unknown, malformed or logged-out token', async () => {
    await seedAdmin();
    const { token } = await auth.login(harness.ctx, { account: 'admin', password: PASSWORD });
    expect(await auth.resolve('nope')).toBeNull();
    expect(await auth.resolve('')).toBeNull();

    await auth.logout(token);
    expect(await auth.resolve(token)).toBeNull();
  });

  it('logout is idempotent', async () => {
    await seedAdmin();
    const { token } = await auth.login(harness.ctx, { account: 'admin', password: PASSWORD });
    await auth.logout(token);
    await expect(auth.logout(token)).resolves.toBeUndefined();
  });

  it('revokes every session of one admin and leaves the others alone', async () => {
    const id = await seedAdmin({ account: 'admin' });
    await seedAdmin({ account: 'other' });
    const a = await auth.login(harness.ctx, { account: 'admin', password: PASSWORD });
    const b = await auth.login(harness.ctx, { account: 'admin', password: PASSWORD });
    const untouched = await auth.login(harness.ctx, { account: 'other', password: PASSWORD });

    expect(await auth.revokeAll(id)).toBe(2);
    expect(await auth.resolve(a.token)).toBeNull();
    expect(await auth.resolve(b.token)).toBeNull();
    expect(await auth.resolve(untouched.token)).not.toBeNull();
  });

  it('changing the password bumps password_version and kills every session', async () => {
    const id = await seedAdmin();
    const first = await auth.login(harness.ctx, { account: 'admin', password: PASSWORD });
    const second = await auth.login(harness.ctx, { account: 'admin', password: PASSWORD });

    await auth.changePassword(harness.ctx, id, 'a-new-password');

    expect(await auth.resolve(first.token)).toBeNull();
    expect(await auth.resolve(second.token)).toBeNull();

    const [row] = await harness.ctx.db.select().from(admins).where(eq(admins.id, id));
    expect(row?.passwordVersion).toBe(2);

    await expect(
      auth.login(harness.ctx, { account: 'admin', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    await expect(
      auth.login(harness.ctx, { account: 'admin', password: 'a-new-password' }),
    ).resolves.toBeDefined();
  });
});

describe('storefront sessions', () => {
  const sessions = new UserSessionService();

  // `user_sessions.user_id` references `users`, so the rows the fake lookup talks about must exist.
  beforeEach(async () => {
    await harness.ctx.db.insert(users).values([
      { id: 7, account: 'user-7' },
      { id: 8, account: 'user-8' },
    ]);
  });

  it('stores sha256(token) and never the token', async () => {
    registerUserLookup(fakeUserLookup([{ id: 7 }]));
    const issued = await sessions.issue(harness.ctx, {
      userId: 7,
      passwordVersion: 1,
      platform: 'h5',
    });

    const [row] = await harness.ctx.db.select().from(userSessions);
    expect(row?.tokenHash).toBe(sha256Hex(issued.token));
    expect(row?.tokenHash).not.toBe(issued.token);
    expect(row?.tokenHash).toHaveLength(64);
  });

  it('resolves a live token and records lastSeenAt', async () => {
    registerUserLookup(fakeUserLookup([{ id: 7 }]));
    const issued = await sessions.issue(harness.ctx, {
      userId: 7,
      passwordVersion: 1,
      platform: 'wechat-mini',
    });

    const resolved = await sessions.resolve(harness.ctx, issued.token);
    expect(resolved).toEqual({
      sessionId: issued.sessionId,
      userId: 7,
      platform: 'wechat-mini',
    });

    const [row] = await harness.ctx.db.select().from(userSessions);
    expect(row?.lastSeenAt?.getTime()).toBe(harness.clock.nowMs());
  });

  it('REJECTS a session whose passwordVersion is stale, and revokes it on sight', async () => {
    // Otherwise a changed password would leave every old token working
    // ("商城令牌不绑定密码").
    const lookup = fakeUserLookup([{ id: 7, passwordVersion: 1 }]);
    registerUserLookup(lookup);
    const issued = await sessions.issue(harness.ctx, {
      userId: 7,
      passwordVersion: 1,
      platform: 'h5',
    });
    expect(await sessions.resolve(harness.ctx, issued.token)).not.toBeNull();

    lookup.changePassword(7);

    expect(await sessions.resolve(harness.ctx, issued.token)).toBeNull();
    const [row] = await harness.ctx.db.select().from(userSessions);
    expect(row?.revokedAt).not.toBeNull();
  });

  it('rejects a disabled user', async () => {
    const lookup = fakeUserLookup([{ id: 7 }]);
    registerUserLookup(lookup);
    const issued = await sessions.issue(harness.ctx, {
      userId: 7,
      passwordVersion: 1,
      platform: 'h5',
    });
    lookup.disable(7);
    expect(await sessions.resolve(harness.ctx, issued.token)).toBeNull();
  });

  it('fails closed when the user domain has not registered a UserLookup', async () => {
    const issued = await sessions.issue(harness.ctx, {
      userId: 7,
      passwordVersion: 1,
      platform: 'h5',
    });
    resetUserLookup();
    expect(await sessions.resolve(harness.ctx, issued.token)).toBeNull();
  });

  it('rejects an expired token', async () => {
    registerUserLookup(fakeUserLookup([{ id: 7 }]));
    const issued = await sessions.issue(harness.ctx, {
      userId: 7,
      passwordVersion: 1,
      platform: 'h5',
      ttlMs: 1000,
    });
    harness.clock.advance(1001);
    expect(await sessions.resolve(harness.ctx, issued.token)).toBeNull();
  });

  it('revokeAllForUser logs every device out at once', async () => {
    registerUserLookup(fakeUserLookup([{ id: 7 }, { id: 8 }]));
    const phone = await sessions.issue(harness.ctx, {
      userId: 7,
      passwordVersion: 1,
      platform: 'h5',
    });
    const mini = await sessions.issue(harness.ctx, {
      userId: 7,
      passwordVersion: 1,
      platform: 'wechat-mini',
    });
    const other = await sessions.issue(harness.ctx, {
      userId: 8,
      passwordVersion: 1,
      platform: 'h5',
    });

    expect(await sessions.revokeAllForUser(harness.ctx, 7)).toBe(2);
    expect(await sessions.resolve(harness.ctx, phone.token)).toBeNull();
    expect(await sessions.resolve(harness.ctx, mini.token)).toBeNull();
    expect(await sessions.resolve(harness.ctx, other.token)).not.toBeNull();

    // Revoking again affects nothing — the rows are already revoked.
    expect(await sessions.revokeAllForUser(harness.ctx, 7)).toBe(0);
  });

  it("revoking a single token leaves the user's other devices alone", async () => {
    registerUserLookup(fakeUserLookup([{ id: 7 }]));
    const a = await sessions.issue(harness.ctx, { userId: 7, passwordVersion: 1, platform: 'h5' });
    const b = await sessions.issue(harness.ctx, { userId: 7, passwordVersion: 1, platform: 'h5' });
    await sessions.revoke(harness.ctx, a.token);
    expect(await sessions.resolve(harness.ctx, a.token)).toBeNull();
    expect(await sessions.resolve(harness.ctx, b.token)).not.toBeNull();
  });

  it('prunes expired rows', async () => {
    registerUserLookup(fakeUserLookup([{ id: 7 }]));
    await sessions.issue(harness.ctx, {
      userId: 7,
      passwordVersion: 1,
      platform: 'h5',
      ttlMs: 1000,
    });
    await sessions.issue(harness.ctx, { userId: 7, passwordVersion: 1, platform: 'h5' });
    harness.clock.advance(2000);
    expect(await sessions.pruneExpired(harness.ctx)).toBe(1);
    expect(await harness.ctx.db.select().from(userSessions)).toHaveLength(1);
  });
});
