import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminRoles, admins, auditLogs, rolePermissions, roles } from '@shop/db/schema/auth';
import { products } from '@shop/db/schema/catalog';
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
 * The catalog routes as HTTP, against a real database.
 *
 * The domain behaviour is pinned down in `@shop/core/catalog`; what is proved
 * here is only what a route file can get wrong — that the contract is bound to
 * the right method and path, that `auth` and `permission` are enforced before
 * the service runs, that a body is validated before anything is written, that
 * the declared status codes come back, and that a write lands in `audit_logs`.
 *
 * Plus one end-to-end pass of 下架 over HTTP, because "下架 hides the product"
 * is a claim about the whole stack and not about a service function.
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
      .values({ name: 'catalog-operator' })
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

async function userSession(): Promise<{ userId: number; headers: Record<string, string> }> {
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

async function makeCategory(headers: Record<string, string>): Promise<string> {
  const { POST } = await import('./categories/route');
  const response = await POST(
    json(
      'POST',
      '/admin-api/catalog/categories',
      { parentId: null, name: '男装', sortOrder: 0, isVisible: true },
      headers,
    ),
  );
  return (await response.json()).id;
}

const productForm = (categoryId: string) => ({
  name: '经典白T恤',
  kind: 'physical',
  status: 'on_shelf',
  imageUrl: 'https://cdn.example.com/p/1.png',
  sliderImages: [],
  specMode: false,
  specs: [],
  skus: [{ specValues: {}, price: '59.00', stock: 12, isDefault: true }],
  freightMode: 'free',
  purchaseLimitMode: 'none',
  descriptionHtml: '<p>经典款。</p>',
  categoryIds: [categoryId],
});

async function makeProduct(headers: Record<string, string>) {
  const categoryId = await makeCategory(headers);
  const { POST } = await import('./products/route');
  const response = await POST(
    json('POST', '/admin-api/catalog/products', productForm(categoryId), headers),
  );
  return { response, product: await response.json(), categoryId };
}

// ---------------------------------------------------------------------------
// the admin surface
// ---------------------------------------------------------------------------

describe('/admin-api/catalog/products', () => {
  it('401s without a session and 403s without the permission', async () => {
    const { GET } = await import('./products/route');

    expect((await GET(get('/admin-api/catalog/products?page=1&pageSize=20'))).status).toBe(401);

    const headers = await adminCookie(['coupon:template:read']);
    const forbidden = await GET(get('/admin-api/catalog/products?page=1&pageSize=20', headers));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).code).toBe('FORBIDDEN');
  });

  it('lists for an admin holding catalog:product:read', async () => {
    const headers = await adminCookie(['catalog:product:read']);
    const { GET } = await import('./products/route');

    const response = await GET(get('/admin-api/catalog/products?page=1&pageSize=20', headers));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('creates with 201 and writes an audit row', async () => {
    const headers = await adminCookie();
    const { response, product } = await makeProduct(headers);

    expect(response.status).toBe(201);
    expect(product).toMatchObject({ name: '经典白T恤', price: '59.00', stock: 12 });

    const audit = await harness.ctx.db.select().from(auditLogs);
    expect(audit.map((row) => row.routeId)).toContain('catalog.adminProductCreate');
    expect(audit.find((row) => row.routeId === 'catalog.adminProductCreate')).toMatchObject({
      target: `product:${product.id}`,
    });
  });

  it('422s a form the contract refuses, before writing anything', async () => {
    const headers = await adminCookie();
    const categoryId = await makeCategory(headers);
    const { POST } = await import('./products/route');

    // A card product's stock is its card pool; typing a number is the exact
    // drift the contract refuses.
    const response = await POST(
      json(
        'POST',
        '/admin-api/catalog/products',
        {
          ...productForm(categoryId),
          kind: 'virtual_card',
          skus: [{ specValues: {}, price: '30.00', stock: 5, isDefault: true }],
        },
        headers,
      ),
    );

    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
    expect(await harness.ctx.db.select().from(products)).toHaveLength(0);
  });

  it('answers ?ids= in the order asked, without the deleted, and refuses more than 100', async () => {
    const headers = await adminCookie(['catalog:product:read']);
    const insert = async (name: string, values: Partial<typeof products.$inferInsert> = {}) => {
      const [row] = await harness.ctx.db
        .insert(products)
        .values({
          name,
          status: 'on_shelf',
          imageUrl: 'https://cdn.example.com/p.jpg',
          price: '60.00',
          stock: 5,
          freightMode: 'free',
          unitName: '件',
          ...values,
        })
        .returning({ id: products.id });
      return String(row!.id);
    };
    const first = await insert('甲', { price: '10.00' });
    const offShelf = await insert('乙', { status: 'off_shelf' });
    const deleted = await insert('丙', { deletedAt: new Date('2026-05-01T00:00:00.000Z') });
    const last = await insert('丁', { price: '90.00' });
    await insert('戊'); // not asked for

    const { GET } = await import('./products/route');
    const ids = async (query: string): Promise<string[]> => {
      const response = await GET(get(`/admin-api/catalog/products?${query}`, headers));
      expect(response.status).toBe(200);
      return ((await response.json()) as { items: { id: string }[] }).items.map((row) => row.id);
    };

    // An operator's saved pick is shown whatever its shelf state; a deleted
    // product is gone, so it is absent rather than an error.
    expect(await ids(`pageSize=4&ids=${last},${deleted},${offShelf},${first}`)).toEqual([
      last,
      offShelf,
      first,
    ]);
    // The list's order is the ids', whatever the sort key says.
    expect(await ids(`ids=${first}&ids=${last}&sortBy=price&sortOrder=desc`)).toEqual([
      first,
      last,
    ]);

    const tooMany = Array.from({ length: 101 }, (_unused, i) => String(i + 1)).join(',');
    const refused = await GET(get(`/admin-api/catalog/products?ids=${tooMany}`, headers));
    expect(refused.status).toBe(422);
  });

  it('keeps the export behind its own permission, because the rows carry cost prices', async () => {
    const headers = await adminCookie(['catalog:product:read', 'catalog:product:write']);
    const { GET } = await import('./product-export/route');

    const forbidden = await GET(get('/admin-api/catalog/product-export?tab=all&limit=10', headers));
    expect(forbidden.status).toBe(403);
  });

  it('exports for an admin who does hold catalog:product:export', async () => {
    const admin = await adminCookie();
    await makeProduct(admin);

    const { GET } = await import('./product-export/route');
    const response = await GET(get('/admin-api/catalog/product-export?tab=all&limit=10', admin));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.filename).toBe('商品-2026-06-01.csv');
    expect(body.rows).toHaveLength(1);
    expect(body.truncated).toBe(false);
  });
});

describe('/admin-api/catalog/reviews', () => {
  it('writes an admin review, replies once, and moderates a batch', async () => {
    const headers = await adminCookie();
    const { product } = await makeProduct(headers);

    const { POST: create } = await import('./reviews/route');
    const created = await (
      await create(
        json(
          'POST',
          '/admin-api/catalog/reviews',
          {
            productId: product.id,
            authorNickname: '小明',
            productScore: 5,
            serviceScore: 5,
            images: [],
          },
          headers,
        ),
      )
    ).json();

    const { POST: reply, PUT: replyUpdate } = await import('./reviews/[id]/reply/route');
    const replied = await reply(
      json('POST', `/admin-api/catalog/reviews/${created.id}/reply`, { content: '谢谢' }, headers),
      { params: { id: created.id } },
    );
    expect(replied.status).toBe(200);

    const again = await reply(
      json('POST', `/admin-api/catalog/reviews/${created.id}/reply`, { content: '再谢' }, headers),
      { params: { id: created.id } },
    );
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('CATALOG_REVIEW_ALREADY_REPLIED');

    const edited = await replyUpdate(
      json('PUT', `/admin-api/catalog/reviews/${created.id}/reply`, { content: '改口' }, headers),
      { params: { id: created.id } },
    );
    expect((await edited.json()).replyContent).toBe('改口');

    const { POST: batch } = await import('./reviews/statuses/route');
    const moderated = await batch(
      json(
        'POST',
        '/admin-api/catalog/reviews/statuses',
        { reviewIds: [created.id], status: 'hidden' },
        headers,
      ),
    );
    expect(await moderated.json()).toEqual({ updated: 1 });
  });
});

// ---------------------------------------------------------------------------
// risk matrix §1, over HTTP
// ---------------------------------------------------------------------------

describe('下架 over HTTP', () => {
  it('takes the product out of the storefront list and off its own page', async () => {
    const headers = await adminCookie();
    const { product } = await makeProduct(headers);

    const { GET: storefrontList } = await import('../../api/v1/catalog/products/route');
    const { GET: storefrontDetail } = await import('../../api/v1/catalog/products/[id]/route');

    const before = await storefrontList(get('/api/v1/catalog/products?page=1&pageSize=20'));
    expect((await before.json()).total).toBe(1);
    expect(
      (
        await storefrontDetail(get(`/api/v1/catalog/products/${product.id}`), {
          params: { id: product.id },
        })
      ).status,
    ).toBe(200);

    const { POST: setStatus } = await import('./products/[id]/status/route');
    const off = await setStatus(
      json(
        'POST',
        `/admin-api/catalog/products/${product.id}/status`,
        { status: 'off_shelf' },
        headers,
      ),
      { params: { id: product.id } },
    );
    expect((await off.json()).status).toBe('off_shelf');

    const after = await storefrontList(get('/api/v1/catalog/products?page=1&pageSize=20'));
    expect((await after.json()).total).toBe(0);

    const gone = await storefrontDetail(get(`/api/v1/catalog/products/${product.id}`), {
      params: { id: product.id },
    });
    expect(gone.status).toBe(404);
    expect((await gone.json()).code).toBe('CATALOG_PRODUCT_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// the storefront surface
// ---------------------------------------------------------------------------

describe('/api/v1/catalog', () => {
  it('serves the category tree to anybody, with a version', async () => {
    const headers = await adminCookie();
    await makeCategory(headers);

    const { GET } = await import('../../api/v1/catalog/categories/route');
    const response = await GET(get('/api/v1/catalog/categories'));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(typeof body.version).toBe('string');
  });

  it('answers a caller holding the current version with a 304', async () => {
    const headers = await adminCookie();
    await makeCategory(headers);

    const { GET: tree } = await import('../../api/v1/catalog/categories/route');
    const tag = (await tree(get('/api/v1/catalog/categories'))).headers.get('etag')!;
    expect(tag).toMatch(/^"[^"]+"$/);

    const response = await tree(get('/api/v1/catalog/categories', { 'if-none-match': tag }));
    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
    expect(response.headers.get('etag')).toBe(tag);

    // The tree moved: the old tag gets the new tree.
    await makeCategory(headers);
    const moved = await tree(get('/api/v1/catalog/categories', { 'if-none-match': tag }));
    expect(moved.status).toBe(200);
    expect(moved.headers.get('etag')).not.toBe(tag);
    expect((await moved.json()).items.length).toBeGreaterThan(1);
  });

  it('requires a signed-in shopper for 我的收藏', async () => {
    const admin = await adminCookie();
    const { product } = await makeProduct(admin);

    const { POST } = await import('../../api/v1/me/favorites/route');
    expect(
      (await POST(json('POST', '/api/v1/me/favorites', { productId: product.id }))).status,
    ).toBe(401);

    const { headers } = await userSession();
    const added = await POST(
      json('POST', '/api/v1/me/favorites', { productId: product.id }, headers),
    );
    expect(added.status).toBe(201);

    const { GET } = await import('../../api/v1/me/favorites/route');
    const list = await GET(get('/api/v1/me/favorites?page=1&pageSize=20', headers));
    expect((await list.json()).total).toBe(1);
  });
});
