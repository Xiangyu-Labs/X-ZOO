import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminRoles, admins, auditLogs, rolePermissions, roles } from '@shop/db/schema/auth';
import { couponTemplates } from '@shop/db/schema/coupon';
import { users } from '@shop/db/schema/user';
import {
  AdminAuthService,
  hashPassword,
  registerUserLookup,
  resetUserLookup,
  UserSessionService,
} from '@shop/core/auth';
import { createTestCtx, fakeUserLookup, type TestCtx } from '@shop/testing';
import { ADMIN_COOKIE } from '../../../src/server/handle';
import { setContainer, type Container } from '../../../src/server/container';
import type { Env } from '../../../src/server/env';

/**
 * The coupon routes as HTTP, against a real database.
 *
 * The domain behaviour is already pinned down in `@shop/core`; what is proved
 * here is only what a route file can get wrong: that the contract is bound to
 * the right method and path, that `auth` and `permission` are enforced before
 * the service runs, that a body is validated before anything is written, that
 * the declared status codes come back, and that a write lands in `audit_logs`.
 *
 * A route test is cheap because the routes are thin. If a slice needs more
 * than this, the logic is in the wrong file.
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
  // The golden slice runs with response validation ON, as CI does.
  VALIDATE_RESPONSES: true,
  DB_POOL_MAX: 5,
  QUEUE_NAME: 'shop',
  APP_VERSION: 'test',
};

beforeAll(async () => {
  harness = await createTestCtx({ now: '2026-06-01T00:00:00.000Z' });
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
  resetUserLookup();
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
      .values({ name: 'coupon-operator' })
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

/** A storefront session for a freshly created customer. */
async function userSession(): Promise<{ userId: number; headers: Record<string, string> }> {
  const [user] = await harness.ctx.db
    .insert(users)
    .values({ account: 'shopper' })
    .returning({ id: users.id });
  // A fake `UserLookup` is enough for a storefront session to resolve without
  // loading the user domain.
  registerUserLookup(fakeUserLookup([{ id: user!.id }]));
  const issued = await new UserSessionService().issue(harness.ctx, {
    userId: user!.id,
    passwordVersion: 1,
    platform: 'h5',
  });
  return { userId: user!.id, headers: { authorization: `Bearer ${issued.token}` } };
}

const templateForm = {
  name: '满 100 减 10',
  scope: 'all_products',
  claimMode: 'manual',
  status: 'active',
  discountAmount: '10.00',
  minSpend: '100.00',
  validityMode: 'days_after_claim',
  validDays: 30,
  isUnlimitedSupply: false,
  totalCount: 100,
  perUserLimit: 1,
  sortOrder: 0,
  productIds: [],
  categoryIds: [],
};

// ---------------------------------------------------------------------------
// admin surface
// ---------------------------------------------------------------------------

describe('/admin-api/coupons', () => {
  it('401s without a session and 403s without the permission', async () => {
    const { GET } = await import('./route');

    expect((await GET(get('/admin-api/coupons?page=1&pageSize=20'))).status).toBe(401);

    const headers = await adminCookie(['catalog:product:read']);
    const forbidden = await GET(get('/admin-api/coupons?page=1&pageSize=20', headers));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).code).toBe('FORBIDDEN');
  });

  it('lists for an admin holding coupon:template:read', async () => {
    const headers = await adminCookie(['coupon:template:read']);
    const response = await GETList(headers);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  async function GETList(headers: Record<string, string>) {
    const { GET } = await import('./route');
    return GET(get('/admin-api/coupons?page=1&pageSize=20', headers));
  }

  it('creates with 201 and writes an audit row', async () => {
    const headers = await adminCookie(['coupon:template:write']);
    const { POST } = await import('./route');

    const response = await POST(json('POST', '/admin-api/coupons', templateForm, headers));
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({ name: '满 100 减 10', remainingCount: 100 });

    const audit = (await harness.ctx.db.select().from(auditLogs)).filter(
      // Sign-ins are audited too; this test is about the operation.
      (row) => row.routeId !== 'auth.adminLogin',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      routeId: 'coupon.adminCreate',
      target: `coupon:${created.id}`,
    });
  });

  it('422s a form the schema refuses, before writing anything', async () => {
    const headers = await adminCookie(['coupon:template:write']);
    const { POST } = await import('./route');

    // `days_after_claim` without `validDays` is exactly what the DB CHECK
    // would refuse; the contract refuses it first, with field-level detail.
    const response = await POST(
      json('POST', '/admin-api/coupons', { ...templateForm, validDays: null }, headers),
    );
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
    expect(await harness.ctx.db.select().from(couponTemplates)).toHaveLength(0);
  });

  it('reads, edits, toggles, grants and deletes through the sub-resources', async () => {
    const headers = await adminCookie(); // super admin
    const { POST: create } = await import('./route');
    const created = await (
      await create(json('POST', '/admin-api/coupons', templateForm, headers))
    ).json();
    const id = created.id;

    const { GET: detail, PUT: update, DELETE: remove } = await import('./[id]/route');
    expect(
      (await detail(get(`/admin-api/coupons/${id}`, headers), { params: { id } })).status,
    ).toBe(200);

    const edited = await update(
      json('PUT', `/admin-api/coupons/${id}`, { ...templateForm, name: '改名' }, headers),
      { params: { id } },
    );
    expect((await edited.json()).name).toBe('改名');

    const { POST: setStatus } = await import('./[id]/status/route');
    const disabled = await setStatus(
      json('POST', `/admin-api/coupons/${id}/status`, { status: 'disabled' }, headers),
      { params: { id } },
    );
    expect((await disabled.json()).status).toBe('disabled');

    const [user] = await harness.ctx.db
      .insert(users)
      .values({ account: 'granted' })
      .returning({ id: users.id });
    const { POST: grant } = await import('./[id]/grants/route');
    const granted = await grant(
      json('POST', `/admin-api/coupons/${id}/grants`, { userIds: [String(user!.id)] }, headers),
      { params: { id } },
    );
    expect(await granted.json()).toEqual({ granted: 1, skippedUserIds: [] });

    // 204 with no body, as the contract declares.
    const deleted = await remove(json('DELETE', `/admin-api/coupons/${id}`, undefined, headers), {
      params: { id },
    });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');
  });

  it('turns a domain refusal into its registered status and Chinese message', async () => {
    const headers = await adminCookie();
    const { GET: detail } = await import('./[id]/route');
    const response = await detail(get('/admin-api/coupons/999999', headers), {
      params: { id: '999999' },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: 'COUPON_TEMPLATE_NOT_FOUND',
      message: '优惠券不存在或已下架',
    });
  });

  it('lists issued coupons on its own resource', async () => {
    const headers = await adminCookie(['coupon:user-coupon:read']);
    const { GET } = await import('../user-coupons/route');
    const response = await GET(get('/admin-api/user-coupons?page=1&pageSize=20', headers));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [], total: 0 });
  });
});

// ---------------------------------------------------------------------------
// storefront surface
// ---------------------------------------------------------------------------

describe('/api/v1/coupons', () => {
  async function seedTemplate(): Promise<number> {
    const [row] = await harness.ctx.db
      .insert(couponTemplates)
      .values({
        name: '满 100 减 10',
        status: 'active',
        claimMode: 'manual',
        discountAmount: '10.00',
        validityMode: 'days_after_claim',
        validDays: 30,
        isUnlimitedSupply: false,
        totalCount: 5,
        remainingCount: 5,
        perUserLimit: 1,
      })
      .returning({ id: couponTemplates.id });
    return row!.id;
  }

  it('serves the claim centre to a signed-out visitor, with null caller state', async () => {
    await seedTemplate();
    const { GET } = await import('../../api/v1/coupons/route');
    const response = await GET(get('/api/v1/coupons?page=1&pageSize=20'));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.items[0]).toMatchObject({ canClaim: null, claimedCount: null });
  });

  it('claims with 201 for a signed-in shopper and refuses the second tap with 409', async () => {
    const templateId = await seedTemplate();
    const { headers } = await userSession();
    const { POST } = await import('../../api/v1/coupons/[id]/claims/route');
    const params = { params: { id: String(templateId) } };

    const first = await POST(
      json('POST', `/api/v1/coupons/${templateId}/claims`, undefined, headers),
      params,
    );
    expect(first.status).toBe(201);
    expect((await first.json()).coupon).toMatchObject({ status: 'unused', sourceKind: 'claim' });

    const second = await POST(
      json('POST', `/api/v1/coupons/${templateId}/claims`, undefined, headers),
      params,
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      code: 'COUPON_PER_USER_LIMIT_REACHED',
      message: '您已领取过该优惠券',
    });
  });

  it('401s a claim with no token', async () => {
    const templateId = await seedTemplate();
    const { POST } = await import('../../api/v1/coupons/[id]/claims/route');
    const response = await POST(
      json('POST', `/api/v1/coupons/${templateId}/claims`, undefined, {}),
      { params: { id: String(templateId) } },
    );
    expect(response.status).toBe(401);
  });

  it('serves the wallet and the checkout picker', async () => {
    const templateId = await seedTemplate();
    const { headers } = await userSession();
    const { POST: claim } = await import('../../api/v1/coupons/[id]/claims/route');
    await claim(json('POST', `/api/v1/coupons/${templateId}/claims`, undefined, headers), {
      params: { id: String(templateId) },
    });

    const { GET: wallet } = await import('../../api/v1/user-coupons/route');
    const mine = await wallet(get('/api/v1/user-coupons?page=1&pageSize=20&state=unused', headers));
    expect((await mine.json()).total).toBe(1);

    const { POST: applicable } = await import('../../api/v1/user-coupons/applicable/route');
    const picker = await applicable(
      json(
        'POST',
        '/api/v1/user-coupons/applicable',
        { lines: [{ productId: '1', categoryIds: [], amount: '200.00' }] },
        headers,
      ),
    );
    expect(picker.status).toBe(200);
    expect(await picker.json()).toMatchObject({
      subtotal: '200.00',
      items: [{ usable: true, discount: '10.00' }],
    });
  });

  it('advertises the new-user coupons without a session', async () => {
    await harness.ctx.db.insert(couponTemplates).values({
      name: '新人礼',
      status: 'active',
      claimMode: 'new_user',
      discountAmount: '5.00',
      validityMode: 'days_after_claim',
      validDays: 7,
      isUnlimitedSupply: true,
    });
    const { GET } = await import('../../api/v1/coupons/new-user/route');
    const response = await GET(get('/api/v1/coupons/new-user'));
    expect(response.status).toBe(200);
    expect((await response.json()).items[0]).toMatchObject({ name: '新人礼', canClaim: null });
  });
});
