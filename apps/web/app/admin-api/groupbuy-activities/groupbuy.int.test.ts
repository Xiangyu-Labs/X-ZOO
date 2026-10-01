import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminRoles, admins, auditLogs, rolePermissions, roles } from '@shop/db/schema/auth';
import { products, productSkus } from '@shop/db/schema/catalog';
import { groupbuyActivities } from '@shop/db/schema/groupbuy';
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
 * The group-buy routes as HTTP, against a real database.
 *
 * The domain behaviour is pinned down in `@shop/core/groupbuy`; what is proved
 * here is only what a route file can get wrong — that the contract is bound to
 * the right method and path, that `auth` and `permission` are enforced before
 * the service runs, that the declared status codes come back, and that a write
 * lands in `audit_logs`.
 *
 * `groupbuy:group:complete` gets its own case, because it is the one atom in
 * this domain that lets an operator invent buyers.
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
      .values({ name: 'groupbuy-operator' })
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

async function shopperSession(): Promise<{ userId: number; headers: Record<string, string> }> {
  const [user] = await harness.ctx.db
    .insert(users)
    .values({ account: 'shopper' })
    .returning({ id: users.id });
  registerUserLookup(fakeUserLookup([{ id: user!.id }]));
  const issued = await new UserSessionService().issue(harness.ctx, {
    userId: user!.id,
    passwordVersion: 1,
    platform: 'h5',
  });
  return { userId: user!.id, headers: { authorization: `Bearer ${issued.token}` } };
}

/** A product with one SKU, which every activity form below points at. */
async function makeProduct(): Promise<{ productId: string; skuId: string }> {
  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: '坚果礼盒',
      imageUrl: 'https://cdn.example.com/p/11.jpg',
      freightMode: 'free',
      price: '88.00',
      stock: 1_000,
    })
    .returning({ id: products.id });
  const [sku] = await harness.ctx.db
    .insert(productSkus)
    .values({
      productId: product!.id,
      skuCode: 'SKU-1',
      specText: '混合装|1000g',
      specValues: { 规格: '混合装' },
      price: '88.00',
      originalPrice: '108.00',
      stock: 1_000,
    })
    .returning({ id: productSkus.id });
  return { productId: String(product!.id), skuId: String(sku!.id) };
}

function activityForm(ids: { productId: string; skuId: string }) {
  return {
    productId: ids.productId,
    title: '三人成团 · 坚果礼盒',
    imageUrl: 'https://cdn.example.com/p/11.jpg',
    sliderImages: [],
    status: 'active',
    price: '59.00',
    originalPrice: '88.00',
    seatsRequired: 3,
    groupTtlSeconds: 86_400,
    stock: 200,
    perOrderQuantity: 1,
    startAt: '2026-05-01T00:00:00+08:00',
    endAt: '2026-10-31T23:59:59+08:00',
    sortOrder: 0,
    skus: [{ skuId: ids.skuId, price: '59.00', stock: 200, isEnabled: true }],
  };
}

// ---------------------------------------------------------------------------
// admin surface
// ---------------------------------------------------------------------------

describe('/admin-api/groupbuy-activities', () => {
  it('401s without a session and 403s without the permission', async () => {
    const { GET } = await import('./route');

    expect((await GET(get('/admin-api/groupbuy-activities?page=1&pageSize=20'))).status).toBe(401);

    const headers = await adminCookie(['catalog:product:read']);
    const forbidden = await GET(get('/admin-api/groupbuy-activities?page=1&pageSize=20', headers));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).code).toBe('FORBIDDEN');
  });

  it('creates with 201 and writes an audit row', async () => {
    const ids = await makeProduct();
    const headers = await adminCookie(['groupbuy:activity:write']);
    const { POST } = await import('./route');

    const response = await POST(
      json('POST', '/admin-api/groupbuy-activities', activityForm(ids), headers),
    );
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({ title: '三人成团 · 坚果礼盒', seatsRequired: 3, stock: 200 });

    const audit = (await harness.ctx.db.select().from(auditLogs)).filter(
      // Sign-ins are audited too; this test is about the operation.
      (row) => row.routeId !== 'auth.adminLogin',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      routeId: 'groupbuy.adminActivityCreate',
      target: `groupbuy-activity:${created.id}`,
    });
  });

  it('422s a two-seat-minimum violation before writing anything', async () => {
    const ids = await makeProduct();
    const headers = await adminCookie(['groupbuy:activity:write']);
    const { POST } = await import('./route');

    // `groupbuy_activities_seats_required` is the DB CHECK; the contract
    // refuses it first, with field-level detail and nothing written.
    const response = await POST(
      json(
        'POST',
        '/admin-api/groupbuy-activities',
        { ...activityForm(ids), seatsRequired: 1 },
        headers,
      ),
    );
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
    expect(await harness.ctx.db.select().from(groupbuyActivities)).toHaveLength(0);
  });

  it('reads, edits, pauses and deletes through the sub-resources', async () => {
    const ids = await makeProduct();
    const headers = await adminCookie();
    const { POST: create } = await import('./route');
    const created = await (
      await create(json('POST', '/admin-api/groupbuy-activities', activityForm(ids), headers))
    ).json();
    const id = created.id;

    const { GET: detail, PUT: update, DELETE: remove } = await import('./[id]/route');
    expect(
      (await detail(get(`/admin-api/groupbuy-activities/${id}`, headers), { params: { id } }))
        .status,
    ).toBe(200);

    const edited = await update(
      json(
        'PUT',
        `/admin-api/groupbuy-activities/${id}`,
        { ...activityForm(ids), title: '改过名字的活动' },
        headers,
      ),
      { params: { id } },
    );
    expect((await edited.json()).title).toBe('改过名字的活动');

    const { POST: setStatus } = await import('./[id]/status/route');
    const paused = await setStatus(
      json('POST', `/admin-api/groupbuy-activities/${id}/status`, { status: 'paused' }, headers),
      { params: { id } },
    );
    expect((await paused.json()).status).toBe('paused');

    const { GET: orders } = await import('./[id]/orders/route');
    const list = await orders(
      get(`/admin-api/groupbuy-activities/${id}/orders?page=1&pageSize=20`, headers),
      { params: { id } },
    );
    expect(await list.json()).toMatchObject({ items: [], total: 0 });

    // 204 with no body, as the contract declares.
    const deleted = await remove(
      json('DELETE', `/admin-api/groupbuy-activities/${id}`, undefined, headers),
      { params: { id } },
    );
    expect(deleted.status).toBe(204);
  });
});

describe('/admin-api/groupbuy-groups and /admin-api/groupbuy-statistics', () => {
  it('lists teams and campaign statistics for the right atoms', async () => {
    const headers = await adminCookie(['groupbuy:group:read', 'groupbuy:activity:read']);

    const { GET: groups } = await import('../groupbuy-groups/route');
    const teams = await groups(get('/admin-api/groupbuy-groups?page=1&pageSize=20', headers));
    expect(teams.status).toBe(200);
    expect(await teams.json()).toMatchObject({ items: [], total: 0 });

    const { GET: stats } = await import('../groupbuy-statistics/route');
    const report = await stats(get('/admin-api/groupbuy-statistics?page=1&pageSize=20', headers));
    expect(report.status).toBe(200);
    expect(await report.json()).toMatchObject({ items: [], total: 0 });
  });

  it('refuses 立即成团 to an admin who may read teams but not complete them', async () => {
    const headers = await adminCookie(['groupbuy:group:read']);
    const { POST } = await import('../groupbuy-groups/[id]/completion/route');

    const response = await POST(
      json('POST', '/admin-api/groupbuy-groups/1/completion', {}, headers),
      { params: { id: '1' } },
    );
    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// storefront surface
// ---------------------------------------------------------------------------

describe('/api/v1/groupbuy', () => {
  it('serves the channel to an anonymous visitor', async () => {
    const { GET: list } = await import('../../api/v1/groupbuy/activities/route');
    const page = await list(get('/api/v1/groupbuy/activities?page=1&pageSize=20'));
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ items: [], total: 0, page: 1, pageSize: 20 });

    const { GET: banners } = await import('../../api/v1/groupbuy/banners/route');
    const heads = await banners(get('/api/v1/groupbuy/banners'));
    expect(await heads.json()).toEqual({ items: [] });
  });

  it('404s an activity that is not there, with the domain code', async () => {
    const { GET } = await import('../../api/v1/groupbuy/activities/[id]/route');
    const response = await GET(get('/api/v1/groupbuy/activities/999'), {
      params: { id: '999' },
    });
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('GROUPBUY_ACTIVITY_NOT_FOUND');
  });

  it('demands a session for 我的拼团 and answers one that has it', async () => {
    const { GET } = await import('../../api/v1/groupbuy/my-groups/route');
    expect((await GET(get('/api/v1/groupbuy/my-groups?page=1&pageSize=20'))).status).toBe(401);

    const { headers } = await shopperSession();
    const mine = await GET(get('/api/v1/groupbuy/my-groups?page=1&pageSize=20', headers));
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({ items: [], total: 0 });
  });
});
