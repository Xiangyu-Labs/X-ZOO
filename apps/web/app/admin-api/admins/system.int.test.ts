import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminRoles, admins, auditLogs, rolePermissions, roles } from '@shop/db/schema/auth';
import { AdminAuthService, hashPassword, UserSessionService } from '@shop/core/auth';
import { configureAdminPasswords } from '@shop/core/system';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { ADMIN_COOKIE } from '../../../src/server/handle';
import { setContainer, type Container } from '../../../src/server/container';
import type { Env } from '../../../src/server/env';

/**
 * The `system` routes as HTTP, against a real database.
 *
 * The domain behaviour is pinned down in `@shop/core`; what is proved here is
 * what a route file can get wrong — the contract bound to the right method and
 * path, `permission` enforced before the service runs, a body validated before
 * anything is written, the declared status codes, an audit row for every write.
 *
 * Plus the two invariants that are only meaningful over HTTP: a settings read
 * must not put a stored credential on the wire, and a role without an atom must
 * get a 403 rather than a filtered list.
 */

let harness: TestCtx;

const PASSWORD = 'xzoo123456';
const BCRYPT_COST = 4;
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
  harness = await createTestCtx({ now: '2026-09-22T08:00:00.000Z' });
  configureAdminPasswords({ bcryptCost: BCRYPT_COST });
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
    adminAuth: new AdminAuthService(harness.ctx, { bcryptCost: BCRYPT_COST }),
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
  });

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { headers });

/** Logs an admin in and returns the cookie header a later request presents. */
async function adminCookie(permissions?: string[]): Promise<Record<string, string>> {
  const [admin] = await harness.ctx.db
    .insert(admins)
    .values({
      account: 'operator',
      passwordHash: await hashPassword(PASSWORD, BCRYPT_COST),
      name: '运营',
      isSuper: permissions === undefined,
    })
    .returning({ id: admins.id });

  if (permissions?.length) {
    const [role] = await harness.ctx.db
      .insert(roles)
      .values({ name: 'system-operator' })
      .returning({ id: roles.id });
    await harness.ctx.db.insert(adminRoles).values({ adminId: admin!.id, roleId: role!.id });
    await harness.ctx.db
      .insert(rolePermissions)
      .values(permissions.map((permission) => ({ roleId: role!.id, permission })));
  }

  const { POST: login } = await import('../auth/login/route');
  const response = await login(
    json('POST', '/admin-api/auth/login', { account: 'operator', password: PASSWORD }),
  );
  const token = new RegExp(`${ADMIN_COOKIE}=([^;]+)`).exec(
    response.headers.get('set-cookie') ?? '',
  )?.[1];
  return { cookie: `${ADMIN_COOKIE}=${token}` };
}

const adminBody = {
  account: 'editor',
  name: '内容编辑',
  password: 'xzoo-123456',
  enabled: true,
  roleIds: [] as string[],
};

// ---------------------------------------------------------------------------

describe('/admin-api/admins', () => {
  it('401s without a session and 403s without the atom', async () => {
    const { GET } = await import('./route');

    expect((await GET(get('/admin-api/admins?page=1&pageSize=20'))).status).toBe(401);

    // A real grant, just not this one: the boundary is the atom, not "has a role".
    const headers = await adminCookie(['coupon:template:read']);
    const forbidden = await GET(get('/admin-api/admins?page=1&pageSize=20', headers));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).code).toBe('FORBIDDEN');
  });

  it('lists for an admin holding system:admin:read', async () => {
    const headers = await adminCookie(['system:admin:read']);
    const { GET } = await import('./route');
    const response = await GET(get('/admin-api/admins?page=1&pageSize=20', headers));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 1, page: 1, pageSize: 20 });
  });

  it('creates with 201 and writes an audit row without the password in it', async () => {
    const headers = await adminCookie(['system:admin:write']);
    const { POST } = await import('./route');

    const response = await POST(json('POST', '/admin-api/admins', adminBody, headers));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ admin: { account: 'editor' } });

    const audit = (await harness.ctx.db.select().from(auditLogs)).filter(
      // Sign-ins are audited too; this test is about the operation.
      (row) => row.routeId !== 'auth.adminLogin',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ routeId: 'system.adminCreate', method: 'POST' });
    // `handle()` redacts before storing; the log must never hand a password to
    // whoever can read 操作日志.
    expect(audit[0]?.payload ?? '').not.toContain('xzoo-123456');
  });

  it('422s a malformed body before writing anything', async () => {
    const headers = await adminCookie(['system:admin:write']);
    const { POST } = await import('./route');
    const response = await POST(
      json('POST', '/admin-api/admins', { ...adminBody, account: 'a b' }, headers),
    );
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
    expect(await harness.ctx.db.select().from(admins)).toHaveLength(1); // only the caller
  });

  it('edits, toggles, resets a password and deletes through the sub-resources', async () => {
    const headers = await adminCookie(); // super admin
    const { POST: create } = await import('./route');
    const created = await (
      await create(json('POST', '/admin-api/admins', adminBody, headers))
    ).json();
    const id = created.admin.id;

    const { GET: detail, PUT: update, DELETE: remove } = await import('./[id]/route');
    expect((await detail(get(`/admin-api/admins/${id}`, headers), { params: { id } })).status).toBe(
      200,
    );

    const edited = await update(
      json('PUT', `/admin-api/admins/${id}`, { ...adminBody, name: '编辑部' }, headers),
      { params: { id } },
    );
    expect((await edited.json()).admin.name).toBe('编辑部');

    const { POST: setStatus } = await import('./[id]/status/route');
    const disabled = await setStatus(
      json('POST', `/admin-api/admins/${id}/status`, { enabled: false }, headers),
      { params: { id } },
    );
    expect((await disabled.json()).admin.enabled).toBe(false);

    const { POST: resetPassword } = await import('./[id]/password/route');
    const reset = await resetPassword(
      json('POST', `/admin-api/admins/${id}/password`, { password: 'another-one' }, headers),
      { params: { id } },
    );
    expect(await reset.json()).toEqual({ revokedSessions: 0 });

    const deleted = await remove(json('DELETE', `/admin-api/admins/${id}`, undefined, headers), {
      params: { id },
    });
    expect(deleted.status).toBe(204);
  });

  it('refuses to disable the last enabled super admin, with a domain code', async () => {
    const headers = await adminCookie(); // the only super admin
    const [me] = await harness.ctx.db.select({ id: admins.id }).from(admins);
    const { POST: setStatus } = await import('./[id]/status/route');
    const response = await setStatus(
      json('POST', `/admin-api/admins/${me!.id}/status`, { enabled: false }, headers),
      { params: { id: String(me!.id) } },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SYSTEM_ADMIN_SELF_LOCKOUT');
  });
});

describe('/admin-api/profile', () => {
  it('is readable by an admin holding no grants at all', async () => {
    // `auth:profile:read` is implicit, so an operator can always see their own
    // account — otherwise a fresh hire logs in to a wall of 403s.
    const headers = await adminCookie([]);
    const { GET } = await import('../profile/route');
    const response = await GET(get('/admin-api/profile', headers));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account: 'operator' });
  });

  it('refuses a password change that does not know the current password', async () => {
    const headers = await adminCookie([]);
    const { POST } = await import('../profile/password/route');
    const response = await POST(
      json(
        'POST',
        '/admin-api/profile/password',
        {
          currentPassword: 'wrong-one',
          newPassword: 'brand-new-1',
          confirmPassword: 'brand-new-1',
        },
        headers,
      ),
    );
    // 422, not 401: the session is fine, the field is wrong.
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('SYSTEM_PASSWORD_MISMATCH');
  });

  it('revokes every session, including the caller’s, on a password change', async () => {
    const headers = await adminCookie([]);
    const { POST } = await import('../profile/password/route');
    const response = await POST(
      json(
        'POST',
        '/admin-api/profile/password',
        { currentPassword: PASSWORD, newPassword: 'brand-new-1', confirmPassword: 'brand-new-1' },
        headers,
      ),
    );
    expect(await response.json()).toEqual({ revokedSessions: 1 });

    // The cookie that just changed the password is now worthless.
    const { GET } = await import('../profile/route');
    expect((await GET(get('/admin-api/profile', headers))).status).toBe(401);
  });
});

describe('/admin-api/roles and /admin-api/permissions', () => {
  it('serves a permission tree built from the code, not from a table', async () => {
    const headers = await adminCookie(['system:role:read']);
    const { GET } = await import('../permissions/route');
    const tree = await (await GET(get('/admin-api/permissions', headers))).json();
    const atoms = tree.sections.flatMap((s: { items: { atom: string }[] }) =>
      s.items.map((i) => i.atom),
    );
    expect(atoms).toContain('system:admin:read');
    expect(atoms).toContain('storage:attachment:write');
    expect(tree.implicit.length).toBeGreaterThan(0);
  });

  it('refuses to delete a role somebody holds', async () => {
    const headers = await adminCookie();
    const { POST: create } = await import('../roles/route');
    const role = await (
      await create(
        json('POST', '/admin-api/roles', { name: '客服', enabled: true, permissions: [] }, headers),
      )
    ).json();

    const { POST: createAdmin } = await import('./route');
    await createAdmin(
      json('POST', '/admin-api/admins', { ...adminBody, roleIds: [role.id] }, headers),
    );

    const { DELETE } = await import('../roles/[id]/route');
    const response = await DELETE(
      json('DELETE', `/admin-api/roles/${role.id}`, undefined, headers),
      { params: { id: role.id } },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SYSTEM_ROLE_IN_USE');
  });
});

describe('/admin-api/system/config', () => {
  it('lists only the groups the caller may read', async () => {
    const headers = await adminCookie(['system:config:read']);
    const { GET } = await import('../system/config-groups/route');
    const response = await GET(get('/admin-api/system/config-groups', headers));
    expect(response.status).toBe(200);
    const { groups } = await response.json();
    expect(groups.map((g: { group: string }) => g.group)).toContain('storage');
    // Read but not write: the index says so rather than offering a 403.
    expect(groups.every((g: { writable: boolean }) => g.writable === false)).toBe(true);
  });

  it('never returns a stored secret — only whether it is set', async () => {
    const headers = await adminCookie(['system:config:read', 'system:config:write']);
    const { PUT } = await import('../system/config/[group]/route');
    const { GET } = await import('../system/config/[group]/route');

    const saved = await PUT(
      json(
        'PUT',
        '/admin-api/system/config/storage',
        { values: { s3SecretAccessKey: 'super-secret-value' } },
        headers,
      ),
      { params: { group: 'storage' } },
    );
    expect(saved.status).toBe(200);
    const body = await saved.text();
    expect(body).not.toContain('super-secret-value');
    expect(JSON.parse(body).values.s3SecretAccessKey).toBe(true);

    const read = await GET(get('/admin-api/system/config/storage', headers), {
      params: { group: 'storage' },
    });
    const text = await read.text();
    expect(text).not.toContain('super-secret-value');
    expect(JSON.parse(text).values.s3SecretAccessKey).toBe(true);
  });

  it('leaves a stored secret alone when another field is saved', async () => {
    // The browser round-trips the "is set" flag. Treating that `true` as the
    // new value would blank out the credential on the next unrelated save.
    const headers = await adminCookie(['system:config:read', 'system:config:write']);
    const { PUT } = await import('../system/config/[group]/route');

    await PUT(
      json(
        'PUT',
        '/admin-api/system/config/storage',
        { values: { s3SecretAccessKey: 'super-secret-value' } },
        headers,
      ),
      { params: { group: 'storage' } },
    );
    const second = await PUT(
      json(
        'PUT',
        '/admin-api/system/config/storage',
        { values: { s3SecretAccessKey: true, s3Bucket: 'shop-assets' } },
        headers,
      ),
      { params: { group: 'storage' } },
    );
    const values = (await second.json()).values;
    expect(values.s3Bucket).toBe('shop-assets');
    expect(values.s3SecretAccessKey).toBe(true);
  });

  it('403s a write for a caller holding only the read atom', async () => {
    const headers = await adminCookie(['system:config:read']);
    const { PUT } = await import('../system/config/[group]/route');
    const response = await PUT(
      json('PUT', '/admin-api/system/config/storage', { values: {} }, headers),
      { params: { group: 'storage' } },
    );
    expect(response.status).toBe(403);
  });

  it('refuses a key the group does not declare', async () => {
    const headers = await adminCookie();
    const { PUT } = await import('../system/config/[group]/route');
    const response = await PUT(
      json('PUT', '/admin-api/system/config/storage', { values: { nonsense: 1 } }, headers),
      { params: { group: 'storage' } },
    );
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('SYSTEM_CONFIG_UNKNOWN_KEY');
  });
});

describe('/admin-api/audit-logs', () => {
  it('shows the writes an operator made, newest first', async () => {
    const headers = await adminCookie();
    const { POST } = await import('./route');
    await POST(json('POST', '/admin-api/admins', adminBody, headers));
    await POST(json('POST', '/admin-api/admins', { ...adminBody, account: 'editor2' }, headers));

    const { GET } = await import('../audit-logs/route');
    const page = await (await GET(get('/admin-api/audit-logs?page=1&pageSize=20', headers))).json();
    // The sign-in that opened the session is listed too.
    expect(page.total).toBe(3);
    expect(page.items.map((item: { routeId: string }) => item.routeId)).toEqual([
      'system.adminCreate',
      'system.adminCreate',
      'auth.adminLogin',
    ]);
  });

  it('does not record a read', async () => {
    // A log where every page view is an entry is a log nobody reads.
    const headers = await adminCookie();
    const { GET } = await import('./route');
    await GET(get('/admin-api/admins?page=1&pageSize=20', headers));
    expect(
      (await harness.ctx.db.select().from(auditLogs)).filter(
        // Sign-ins are audited too; this test is about the operation.
        (row) => row.routeId !== 'auth.adminLogin',
      ),
    ).toHaveLength(0);
  });
});
