import fs from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { admins, auditLogs } from '@shop/db/schema/auth';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { AdminAuthService } from './admin-auth.service';
import { hashPassword } from './password';
import { insertAudit } from './audit.repo';

/**
 * The console sign-in, read as somebody guessing passwords.
 *
 * The per-account window parks an account after five misses. That alone leaves
 * nothing behind: a failure only throws, the route is `auth: 'public'` so
 * `handle()` writes no audit row (by design — the body holds the password), and
 * the lockout itself is a Redis counter that expires. An operator asked "was
 * somebody trying our admin passwords last week" would have no row to read, and
 * neither would the successful login that follows a run of failures.
 *
 * So `login` records the *outcome* of each attempt — account, result, address,
 * user agent, never the body — in `audit_logs` under `auth.adminLogin`.
 */

let harness: TestCtx;
let auth: AdminAuthService;

const PASSWORD = 'xzoo123456';
const GUESS = 'guess-0001';

beforeAll(async () => {
  harness = await createTestCtx();
  auth = new AdminAuthService(harness.ctx, { bcryptCost: 4 });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
  await harness.ctx.db.insert(admins).values({
    account: 'admin',
    passwordHash: await hashPassword(PASSWORD, 4),
    passwordAlgo: 'bcrypt',
    name: '超级管理员',
    isSuper: true,
    status: 1,
  });
});

describe('what a password-guessing run leaves behind', () => {
  it('parks the account after five misses', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await auth.login(harness.ctx, { account: 'admin', password: GUESS }).catch(() => undefined);
    }
    await expect(
      auth.login(harness.ctx, { account: 'admin', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'AUTH_TOO_MANY_ATTEMPTS' });
  });

  it('leaves a readable trail of the failed attempts, without the password', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await auth.login(harness.ctx, { account: 'admin', password: GUESS }).catch(() => undefined);
    }

    const rows = await harness.ctx.db.select().from(auditLogs);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(rows)).toContain('admin');
    expect(JSON.stringify(rows)).not.toContain(GUESS);
  });

  it('writes one row per outcome, naming the account, the result and the address', async () => {
    const meta = { ip: '203.0.113.9', userAgent: 'Mozilla/5.0 probe' };
    await auth
      .login(harness.ctx, { account: 'nobody', password: GUESS }, meta)
      .catch(() => undefined);
    await auth
      .login(harness.ctx, { account: 'admin', password: GUESS }, meta)
      .catch(() => undefined);
    await auth.login(harness.ctx, { account: 'admin', password: PASSWORD }, meta);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await auth
        .login(harness.ctx, { account: 'admin', password: GUESS }, meta)
        .catch(() => undefined);
    }

    const rows = (await harness.ctx.db.select().from(auditLogs)).sort((a, b) => a.id - b.id);
    expect(rows.every((row) => row.routeId === 'auth.adminLogin')).toBe(true);
    expect(rows.every((row) => row.ip === '203.0.113.9')).toBe(true);
    const results = rows.map((row) => JSON.parse(row.payload ?? '{}').result);
    expect(results).toEqual([
      'invalid_credentials',
      'invalid_credentials',
      'success',
      'invalid_credentials',
      'invalid_credentials',
      'invalid_credentials',
      'invalid_credentials',
      'invalid_credentials',
    ]);
    // The unknown account has no admin id; the real one does.
    expect(rows[0]).toMatchObject({
      adminId: null,
      adminAccount: 'nobody',
      status: 401,
      errorCode: 'AUTH_INVALID_CREDENTIALS',
    });
    // The viewer's 失败原因 is the refusal's own Chinese message.
    expect(rows[0]!.errorMessage).toMatch(/[\u4e00-\u9fa5]/);
    expect(rows[2]).toMatchObject({ errorCode: null, errorMessage: null });
    expect(rows[1]!.adminId).not.toBeNull();
    expect(rows[2]).toMatchObject({ status: 200, target: `admin:${rows[1]!.adminId}` });
    expect(JSON.parse(rows[2]!.payload!)).toEqual({
      account: 'admin',
      result: 'success',
      userAgent: 'Mozilla/5.0 probe',
    });

    // The next attempt is parked, and that is recorded too.
    await auth
      .login(harness.ctx, { account: 'admin', password: PASSWORD }, meta)
      .catch(() => undefined);
    const [locked] = (await harness.ctx.db.select().from(auditLogs)).sort((a, b) => b.id - a.id);
    expect(locked).toMatchObject({ status: 429, errorCode: 'AUTH_TOO_MANY_ATTEMPTS' });
    expect(JSON.parse(locked!.payload!)).toMatchObject({ result: 'locked' });

    expect(JSON.stringify(await harness.ctx.db.select().from(auditLogs))).not.toContain(GUESS);
    expect(JSON.stringify(await harness.ctx.db.select().from(auditLogs))).not.toContain(PASSWORD);
  });

  it('records a disabled account after the right password, as disabled', async () => {
    await harness.ctx.db.update(admins).set({ status: 0 });
    await expect(
      auth.login(harness.ctx, { account: 'admin', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_DISABLED' });
    const [row] = await harness.ctx.db.select().from(auditLogs);
    expect(row).toMatchObject({ status: 403, ip: null, errorCode: 'AUTH_ACCOUNT_DISABLED' });
    expect(JSON.parse(row!.payload!)).toMatchObject({ result: 'disabled', userAgent: null });
  });

  it('migration 0028 gives a refusal written before it the reason a new row gets', async () => {
    const legacy = (code: string | null, status: number, requestId: string) =>
      insertAudit(harness.ctx.db, {
        adminId: null,
        adminAccount: 'admin',
        routeId: 'auth.adminLogin',
        method: 'POST',
        path: '/admin-api/auth/login',
        status,
        payload: { account: 'admin', result: 'x', ...(code ? { code } : {}), userAgent: null },
        requestId,
        now: harness.clock.now(),
      });
    await legacy('AUTH_INVALID_CREDENTIALS', 401, 'old-401');
    await legacy(null, 500, 'old-500');
    await legacy(null, 200, 'old-200');

    const migration = fs.readFileSync(
      new URL('../../../db/migrations/0028_audit_failures.sql', import.meta.url),
      'utf8',
    );
    const backfill = migration
      .split('--> statement-breakpoint')
      .find((statement) => statement.includes('UPDATE "audit_logs"'));
    expect(backfill).toBeDefined();
    await harness.ctx.db.execute(sql.raw(backfill!));

    const rows = await harness.ctx.db.select().from(auditLogs);
    const byRequest = Object.fromEntries(rows.map((row) => [row.requestId, row]));
    expect(byRequest['old-401']).toMatchObject({
      errorCode: 'AUTH_INVALID_CREDENTIALS',
      errorMessage: '账号或密码不正确',
    });
    expect(byRequest['old-500']).toMatchObject({
      errorCode: 'INTERNAL',
      errorMessage: '服务器开小差了，请稍后再试',
    });
    expect(byRequest['old-200']).toMatchObject({ errorCode: null, errorMessage: null });
  });
});
