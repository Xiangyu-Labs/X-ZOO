import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminRoles, admins, auditLogs, rolePermissions, roles } from '@shop/db/schema/auth';
import { products, productSkus } from '@shop/db/schema/catalog';
import { presaleActivities } from '@shop/db/schema/presale';
import {
  AdminAuthService,
  hashPassword,
  resetUserLookup,
  UserSessionService,
} from '@shop/core/auth';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { ADMIN_COOKIE } from '../../../src/server/handle';
import { setContainer, type Container } from '../../../src/server/container';
import type { Env } from '../../../src/server/env';

/**
 * The presale routes as HTTP, against a real database.
 *
 * The domain behaviour is already pinned down in `@shop/core`; what is proved
 * here is only what a route file can get wrong: that the contract is bound to
 * the right method and path, that `auth` and `permission` are enforced before
 * the service runs, that a body is validated before anything is written, that
 * the declared status codes come back, and that a write lands in `audit_logs`.
 *
 * `VALIDATE_RESPONSES: true` is the part that earns its keep on this domain:
 * every presale response carries ids and money as strings, and a mapper that
 * leaked a JavaScript number would 500 here rather than reach a client.
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
      .values({ name: 'presale-operator' })
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

/** A product with one SKU, so a campaign has something to be about. */
async function seedProduct(): Promise<{ productId: string; skuId: string }> {
  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: '明前龙井',
      imageUrl: 'https://example.test/p.png',
      freightMode: 'free',
      price: '88.00',
      stock: 1_000,
    })
    .returning({ id: products.id });
  const [sku] = await harness.ctx.db
    .insert(productSkus)
    .values({
      productId: product!.id,
      skuCode: 'LJ-250',
      specText: '一级|250g',
      specValues: { 等级: '一级' },
      price: '88.00',
      originalPrice: '108.00',
      stock: 1_000,
    })
    .returning({ id: productSkus.id });
  return { productId: String(product!.id), skuId: String(sku!.id) };
}

const activityForm = (over: Record<string, unknown> = {}) => ({
  productId: '0',
  title: '春茶预售 · 明前龙井',
  intro: '付款后 15 天内发货',
  imageUrl: 'https://example.test/p.png',
  sliderImages: [],
  status: 'active',
  paymentMode: 'full',
  price: '59.00',
  originalPrice: '88.00',
  stock: 500,
  perOrderQuantity: 2,
  startAt: '2026-05-01T00:00:00.000Z',
  endAt: '2026-07-01T00:00:00.000Z',
  shipAfterDays: 15,
  sortOrder: 0,
  skus: [],
  ...over,
});

// ---------------------------------------------------------------------------
// admin surface
// ---------------------------------------------------------------------------

describe('/admin-api/presale-activities', () => {
  it('401s without a session and 403s without the permission', async () => {
    const { GET } = await import('./route');

    expect((await GET(get('/admin-api/presale-activities?page=1&pageSize=20'))).status).toBe(401);

    const headers = await adminCookie(['catalog:product:read']);
    const forbidden = await GET(get('/admin-api/presale-activities?page=1&pageSize=20', headers));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).code).toBe('FORBIDDEN');
  });

  it('lists for an admin holding presale:activity:read', async () => {
    const headers = await adminCookie(['presale:activity:read']);
    const { GET } = await import('./route');
    const response = await GET(get('/admin-api/presale-activities?page=1&pageSize=20', headers));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('creates with 201 and writes an audit row', async () => {
    const { productId, skuId } = await seedProduct();
    const headers = await adminCookie(['presale:activity:write']);
    const { POST } = await import('./route');

    const response = await POST(
      json(
        'POST',
        '/admin-api/presale-activities',
        activityForm({
          productId,
          skus: [{ skuId, price: '59.00', stock: 500, isEnabled: true }],
        }),
        headers,
      ),
    );
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({
      title: '春茶预售 · 明前龙井',
      productName: '明前龙井',
      paymentMode: 'full',
      stock: 500,
      sales: 0,
      shipAfterDays: 15,
    });
    // Ids and money cross the wire as strings; `VALIDATE_RESPONSES` would have
    // rejected anything else, and this says so out loud.
    expect(created.id).toEqual(expect.any(String));
    expect(created.skus[0]).toMatchObject({ skuId, price: '59.00' });

    const audit = (await harness.ctx.db.select().from(auditLogs)).filter(
      // Sign-ins are audited too; this test is about the operation.
      (row) => row.routeId !== 'auth.adminLogin',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      routeId: 'presale.adminActivityCreate',
      target: `presale:${created.id}`,
    });
  });

  it('422s a window that ends before it starts, before writing anything', async () => {
    const { productId } = await seedProduct();
    const headers = await adminCookie(['presale:activity:write']);
    const { POST } = await import('./route');

    // `presale_activities_window_ordered` would refuse this; the contract
    // refuses it first, with field-level detail.
    const response = await POST(
      json(
        'POST',
        '/admin-api/presale-activities',
        activityForm({
          productId,
          startAt: '2026-07-01T00:00:00.000Z',
          endAt: '2026-05-01T00:00:00.000Z',
        }),
        headers,
      ),
    );
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
    expect(await harness.ctx.db.select().from(presaleActivities)).toHaveLength(0);
  });

  it('422s a deposit campaign at the contract, not at the database', async () => {
    const { productId } = await seedProduct();
    const headers = await adminCookie(['presale:activity:write']);
    const { POST } = await import('./route');

    const response = await POST(
      json(
        'POST',
        '/admin-api/presale-activities',
        activityForm({ productId, paymentMode: 'deposit' }),
        headers,
      ),
    );
    expect(response.status).toBe(422);
    expect(await harness.ctx.db.select().from(presaleActivities)).toHaveLength(0);
  });

  it('reads, edits, toggles and deletes through the sub-resources', async () => {
    const { productId, skuId } = await seedProduct();
    const headers = await adminCookie(); // super admin
    const { POST: create } = await import('./route');
    const created = await (
      await create(
        json(
          'POST',
          '/admin-api/presale-activities',
          activityForm({
            productId,
            skus: [{ skuId, price: '59.00', stock: 500, isEnabled: true }],
          }),
          headers,
        ),
      )
    ).json();
    const id = created.id;

    const { GET: detail, PUT: update, DELETE: remove } = await import('./[id]/route');
    expect(
      (await detail(get(`/admin-api/presale-activities/${id}`, headers), { params: { id } }))
        .status,
    ).toBe(200);

    const edited = await update(
      json(
        'PUT',
        `/admin-api/presale-activities/${id}`,
        activityForm({
          productId,
          title: '春茶预售（改名）',
          skus: [{ skuId, price: '49.00', stock: 400, isEnabled: true }],
        }),
        headers,
      ),
      { params: { id } },
    );
    const updated = await edited.json();
    expect(updated.title).toBe('春茶预售（改名）');
    expect(updated.skus[0]).toMatchObject({ price: '49.00', stock: 400 });

    const { POST: setStatus } = await import('./[id]/status/route');
    const paused = await setStatus(
      json('POST', `/admin-api/presale-activities/${id}/status`, { status: 'paused' }, headers),
      { params: { id } },
    );
    expect((await paused.json()).status).toBe('paused');

    // 204 with no body, as the contract declares.
    const deleted = await remove(
      json('DELETE', `/admin-api/presale-activities/${id}`, undefined, headers),
      { params: { id } },
    );
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');
  });

  it('turns a domain refusal into its registered status and Chinese message', async () => {
    const headers = await adminCookie();
    const { GET: detail } = await import('./[id]/route');
    const response = await detail(get('/admin-api/presale-activities/999999', headers), {
      params: { id: '999999' },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: 'PRESALE_ACTIVITY_NOT_FOUND',
      message: expect.any(String),
    });
  });

  it('lists presale orders on its own resource, behind its own permission', async () => {
    const { GET } = await import('../presale-orders/route');

    const wrong = await adminCookie(['presale:activity:read']);
    expect((await GET(get('/admin-api/presale-orders?page=1&pageSize=20', wrong))).status).toBe(
      403,
    );

    await harness.db.truncateAll();
    const headers = await adminCookie(['presale:order:read']);
    const response = await GET(get('/admin-api/presale-orders?page=1&pageSize=20', headers));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [], total: 0 });
  });
});

// ---------------------------------------------------------------------------
// storefront surface
// ---------------------------------------------------------------------------

describe('/api/v1/presale/activities', () => {
  async function seedActivity(
    over: Partial<typeof presaleActivities.$inferInsert> = {},
  ): Promise<{ id: number; skuId: string }> {
    const { productId, skuId } = await seedProduct();
    const [row] = await harness.ctx.db
      .insert(presaleActivities)
      .values({
        productId: Number(productId),
        title: '春茶预售 · 明前龙井',
        status: 'active',
        paymentMode: 'full',
        price: '59.00',
        stock: 500,
        perOrderQuantity: 2,
        startAt: new Date('2026-05-01T00:00:00.000Z'),
        endAt: new Date('2026-07-01T00:00:00.000Z'),
        shipAfterDays: 15,
        ...over,
      })
      .returning({ id: presaleActivities.id });
    return { id: row!.id, skuId };
  }

  it('serves the channel list to a visitor with no session at all', async () => {
    await seedActivity();
    const { GET } = await import('../../api/v1/presale/activities/route');
    const response = await GET(get('/api/v1/presale/activities?page=1&pageSize=10'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      title: '春茶预售 · 明前龙井',
      price: '59.00',
      shipAfterDays: 15,
      canBuy: true,
    });
  });

  it('hides a campaign outside its window', async () => {
    await seedActivity({
      startAt: new Date('2026-06-10T00:00:00.000Z'),
      endAt: new Date('2026-06-20T00:00:00.000Z'),
    });
    const { GET } = await import('../../api/v1/presale/activities/route');
    const response = await GET(get('/api/v1/presale/activities?page=1&pageSize=10'));
    expect((await response.json()).total).toBe(0);
  });

  it('serves the detail with the campaign SKUs, and 404s an unknown one', async () => {
    const { id } = await seedActivity();
    const { GET } = await import('../../api/v1/presale/activities/[id]/route');

    const response = await GET(get(`/api/v1/presale/activities/${id}`), {
      params: { id: String(id) },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      activityId: String(id),
      canBuy: true,
      perOrderQuantity: 2,
      skus: [],
    });

    const missing = await GET(get('/api/v1/presale/activities/999999'), {
      params: { id: '999999' },
    });
    expect(missing.status).toBe(404);
  });
});
