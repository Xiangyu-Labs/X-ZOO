import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cartItems } from '@shop/db/schema/cart';
import { productSkus, products } from '@shop/db/schema/catalog';
import { expressCompanies } from '@shop/db/schema/reference';
import { couponTemplates, userCoupons } from '@shop/db/schema/coupon';
import { orders } from '@shop/db/schema/order';
import { userAddresses, users } from '@shop/db/schema/user';
import {
  AdminAuthService,
  registerUserLookup,
  resetUserLookup,
  UserSessionService,
} from '@shop/core/auth';
import { createTestCtx, fakeUserLookup, type TestCtx } from '@shop/testing';
import { setContainer, type Container } from '../../../src/server/container';
import type { Env } from '../../../src/server/env';

/**
 * The cart, checkout and order routes as HTTP, against a real database.
 *
 * The domain behaviour is pinned down in `@shop/core`; what is proved here is
 * only what a route file can get wrong — that the contract is bound to the
 * right method and path, that `auth: 'user'` is enforced before the service
 * runs, that a malformed body is refused before anything is written, that the
 * declared status codes come back, and that the response really matches the
 * contract's schema (the container runs with `VALIDATE_RESPONSES` on, as CI
 * does).
 *
 * A route test is cheap because the routes are thin. If this file ever needs
 * to grow a branch, the logic is in the wrong place.
 */

let harness: TestCtx;

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
  harness = await createTestCtx({ now: '2026-06-01T00:00:00.000Z', platform: 'h5' });
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
    adminAuth: new AdminAuthService(harness.ctx, { bcryptCost: 4 }),
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
  harness.clock.set('2026-06-01T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      'x-client-platform': 'h5',
      ...headers,
    },
  });

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { headers: { 'x-client-platform': 'h5', ...headers } });

let sequence = 0;

/** A storefront session for a freshly created customer. */
async function shopper(): Promise<{ userId: number; headers: Record<string, string> }> {
  sequence += 1;
  const [user] = await harness.ctx.db
    .insert(users)
    .values({ account: `shopper-${sequence}` })
    .returning({ id: users.id });
  await harness.ctx.db.insert(userAddresses).values({
    userId: user!.id,
    receiverName: '张三',
    receiverPhone: '13800138000',
    provinceName: '浙江省',
    cityName: '杭州市',
    detail: '文三路 100 号',
    isDefault: true,
  });
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

async function sellable(): Promise<{ productId: number; skuId: number }> {
  sequence += 1;
  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `商品${sequence}`,
      status: 'on_shelf',
      imageUrl: 'https://cdn.example.com/p.jpg',
      unitName: '件',
      price: '60.00',
      stock: 10,
      freightMode: 'free',
    })
    .returning({ id: products.id });
  const [sku] = await harness.ctx.db
    .insert(productSkus)
    .values({
      productId: product!.id,
      skuCode: `SKU-${sequence}`,
      specText: '默认',
      price: '60.00',
      stock: 10,
      isDefault: true,
    })
    .returning({ id: productSkus.id });
  return { productId: product!.id, skuId: sku!.id };
}

// ---------------------------------------------------------------------------
// cart
// ---------------------------------------------------------------------------

describe('/api/v1/cart', () => {
  it('401s without a session', async () => {
    const { GET } = await import('./cart/route');
    const response = await GET(get('/api/v1/cart?page=1&pageSize=20'));
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('UNAUTHENTICATED');
  });

  it('adds with 201 and lists what was added', async () => {
    const { headers } = await shopper();
    const item = await sellable();

    const { POST } = await import('./cart/items/route');
    const added = await POST(
      json('POST', '/api/v1/cart/items', { skuId: String(item.skuId), quantity: 2 }, headers),
    );
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({
      item: { quantity: 2, subtotal: '120.00', available: true, state: 'ok' },
      cart: { items: 1, quantity: 2 },
    });

    const { GET } = await import('./cart/route');
    const listed = await GET(get('/api/v1/cart?page=1&pageSize=20', headers));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ total: 1, selectedTotal: '120.00' });
  });

  it('refuses a malformed body before it writes anything', async () => {
    const { headers } = await shopper();
    const { POST } = await import('./cart/items/route');

    const response = await POST(
      json('POST', '/api/v1/cart/items', { skuId: 'not-an-id', quantity: 0 }, headers),
    );
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
    expect(await harness.ctx.db.select().from(cartItems)).toHaveLength(0);
  });

  it('turns a domain refusal into its declared status', async () => {
    const { headers } = await shopper();
    const item = await sellable();
    const { POST } = await import('./cart/items/route');

    const response = await POST(
      json('POST', '/api/v1/cart/items', { skuId: String(item.skuId), quantity: 999 }, headers),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('CART_OUT_OF_STOCK');
  });

  it('answers the badge from its own route', async () => {
    const { headers } = await shopper();
    const item = await sellable();
    const { POST } = await import('./cart/items/route');
    await POST(json('POST', '/api/v1/cart/items', { skuId: String(item.skuId) }, headers));

    const { GET } = await import('./cart/count/route');
    const response = await GET(get('/api/v1/cart/count', headers));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: 1,
      quantity: 1,
      availableCount: 1,
      unavailableCount: 0,
    });
  });
});

describe('/api/v1/cart/items/:id on PUT (wx.request has no PATCH)', () => {
  it('sets the quantity exactly as PATCH does, and answers the same body', async () => {
    const { headers } = await shopper();
    const item = await sellable();
    const { POST } = await import('./cart/items/route');
    const added = await POST(
      json('POST', '/api/v1/cart/items', { skuId: String(item.skuId), quantity: 1 }, headers),
    );
    const rowId = (await added.json()).item.id as string;

    const byId = await import('./cart/items/[id]/route');
    const context = { params: Promise.resolve({ id: rowId }) };
    const put = await byId.PUT(
      json('PUT', `/api/v1/cart/items/${rowId}`, { quantity: 3 }, headers),
      context,
    );
    expect(put.status).toBe(200);
    const putBody = await put.json();
    expect(putBody).toMatchObject({ item: { id: rowId, quantity: 3, subtotal: '180.00' } });

    const patch = await byId.PATCH(
      json('PATCH', `/api/v1/cart/items/${rowId}`, { quantity: 3 }, headers),
      { params: Promise.resolve({ id: rowId }) },
    );
    expect(await patch.json()).toEqual(putBody);
  });

  it('refuses the same things PATCH refuses', async () => {
    const { headers } = await shopper();
    const byId = await import('./cart/items/[id]/route');
    const missing = await byId.PUT(
      json('PUT', '/api/v1/cart/items/999', { quantity: 2 }, headers),
      {
        params: Promise.resolve({ id: '999' }),
      },
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('CART_ITEM_NOT_FOUND');

    const anonymous = await byId.PUT(json('PUT', '/api/v1/cart/items/1', { quantity: 2 }), {
      params: Promise.resolve({ id: '1' }),
    });
    expect(anonymous.status).toBe(401);
  });
});

describe('/api/v1/express-companies', () => {
  it('lists the enabled carriers to anyone, most used first', async () => {
    await harness.ctx.db.insert(expressCompanies).values([
      { code: 'ZTO', name: '中通快递', sortOrder: 10 },
      { code: 'SF', name: '顺丰速运', sortOrder: 100 },
      { code: 'OLD', name: '停用快递', sortOrder: 999, isEnabled: false },
    ]);
    const { GET } = await import('./express-companies/route');
    const response = await GET(get('/api/v1/express-companies'));
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: { code: string }[] };
    expect(items.map((row) => row.code)).toEqual(['SF', 'ZTO']);

    // SHIP-003: searched and capped on the server.
    const searched = await GET(get('/api/v1/express-companies?keyword=%E4%B8%AD%E9%80%9A&limit=5'));
    expect(searched.status).toBe(200);
    const found = (await searched.json()) as { items: { code: string }[] };
    expect(found.items.map((row) => row.code)).toEqual(['ZTO']);
    const tooMany = await GET(get('/api/v1/express-companies?limit=101'));
    expect(tooMany.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// checkout and orders
// ---------------------------------------------------------------------------

describe('/api/v1/checkout and /api/v1/orders', () => {
  async function cartWithOneItem() {
    const session = await shopper();
    const item = await sellable();
    const { POST } = await import('./cart/items/route');
    await POST(
      json(
        'POST',
        '/api/v1/cart/items',
        { skuId: String(item.skuId), quantity: 2 },
        session.headers,
      ),
    );
    return { ...session, item };
  }

  it('previews without writing, then creates with 201', async () => {
    const { headers, item } = await cartWithOneItem();

    const { POST: preview } = await import('./checkout/preview/route');
    const previewed = await preview(
      json('POST', '/api/v1/checkout/preview', { source: 'cart' }, headers),
    );
    expect(previewed.status).toBe(200);
    const draft = await previewed.json();
    expect(draft).toMatchObject({
      itemsAmount: '120.00',
      payableAmount: '120.00',
      addressRequired: true,
      payWindowMinutes: 30,
      shipAfterDays: null,
    });
    expect(await harness.ctx.db.select().from(cartItems)).toHaveLength(1);

    const { POST: create } = await import('./orders/route');
    const created = await create(
      json(
        'POST',
        '/api/v1/orders',
        {
          source: 'cart',
          idempotencyKey: 'ck-20260601-000001',
          expectedPayableAmount: draft.payableAmount,
        },
        headers,
      ),
    );
    expect(created.status).toBe(201);
    const order = await created.json();
    expect(order).toMatchObject({ status: 'pending_payment', payableAmount: '120.00' });
    expect(order.items).toHaveLength(1);
    expect(order.items[0].skuId).toBe(String(item.skuId));
    expect(await harness.ctx.db.select().from(cartItems)).toHaveLength(0);
  });

  it('returns the same order for a replayed submit, still 201', async () => {
    const { headers } = await cartWithOneItem();
    const { POST: create } = await import('./orders/route');
    const body = { source: 'cart', idempotencyKey: 'ck-20260601-000002' };

    const first = await create(json('POST', '/api/v1/orders', body, headers));
    const second = await create(json('POST', '/api/v1/orders', body, headers));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await second.json()).id).toBe((await first.json()).id);
  });

  it('lists, counts and details the order the shopper just placed', async () => {
    const { headers } = await cartWithOneItem();
    const { POST: create, GET: listRoute } = await import('./orders/route');
    const created = await create(
      json(
        'POST',
        '/api/v1/orders',
        { source: 'cart', idempotencyKey: 'ck-20260601-000003' },
        headers,
      ),
    );
    const orderId = (await created.json()).id as string;

    const listed = await listRoute(get('/api/v1/orders?page=1&pageSize=20&tab=unpaid', headers));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ total: 1, page: 1, pageSize: 20 });

    const { GET: countsRoute } = await import('./orders/counts/route');
    const counts = await countsRoute(get('/api/v1/orders/counts', headers));
    expect(await counts.json()).toMatchObject({ all: 1, unpaid: 1 });

    const { GET: detailRoute } = await import('./orders/[id]/route');
    const detail = await detailRoute(get(`/api/v1/orders/${orderId}`, headers), {
      params: { id: orderId },
    });
    expect(detail.status).toBe(200);
    expect((await detail.json()).id).toBe(orderId);
  });

  it('cancels through the sub-resource and refuses the second attempt with 409', async () => {
    const { headers } = await cartWithOneItem();
    const { POST: create } = await import('./orders/route');
    const created = await create(
      json(
        'POST',
        '/api/v1/orders',
        { source: 'cart', idempotencyKey: 'ck-20260601-000004' },
        headers,
      ),
    );
    const orderId = (await created.json()).id as string;

    const { POST: cancelRoute } = await import('./orders/[id]/cancel/route');
    const cancelled = await cancelRoute(
      json('POST', `/api/v1/orders/${orderId}/cancel`, { reason: '不想要了' }, headers),
      { params: { id: orderId } },
    );
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      status: 'cancelled',
      cancelReason: '不想要了',
      payExpiresAt: null,
    });

    const again = await cancelRoute(json('POST', `/api/v1/orders/${orderId}/cancel`, {}, headers), {
      params: { id: orderId },
    });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('ORDER_NOT_CANCELLABLE');
  });

  it('gives a stranger the same 404 an unknown id gets', async () => {
    const { headers } = await cartWithOneItem();
    const { POST: create } = await import('./orders/route');
    const created = await create(
      json(
        'POST',
        '/api/v1/orders',
        { source: 'cart', idempotencyKey: 'ck-20260601-000005' },
        headers,
      ),
    );
    const orderId = (await created.json()).id as string;

    const stranger = await shopper();
    const { GET: detailRoute } = await import('./orders/[id]/route');

    const mine = await detailRoute(get(`/api/v1/orders/${orderId}`, stranger.headers), {
      params: { id: orderId },
    });
    const missing = await detailRoute(get('/api/v1/orders/999999', stranger.headers), {
      params: { id: '999999' },
    });

    expect(mine.status).toBe(404);
    expect(missing.status).toBe(404);
    expect((await mine.json()).code).toBe((await missing.json()).code);
  });

  /**
   * ORDER-004. Checked over real HTTP because the refusal has to happen
   * *before* any write: an order that got as far as taking stock and then
   * failed on the coupon would leave the stock decremented.
   */
  it('refuses a coupon that was already spent, and writes nothing', async () => {
    const { headers, userId, item } = await cartWithOneItem();
    const [template] = await harness.ctx.db
      .insert(couponTemplates)
      .values({
        name: '满 50 减 5',
        status: 'active',
        claimMode: 'manual',
        discountAmount: '5.00',
        minSpend: '50.00',
        validityMode: 'days_after_claim',
        validDays: 30,
        isUnlimitedSupply: true,
        perUserLimit: 1,
      })
      .returning({ id: couponTemplates.id });
    const [spent] = await harness.ctx.db
      .insert(userCoupons)
      .values({
        templateId: template!.id,
        userId,
        claimSlot: 1,
        sourceKind: 'claim',
        title: '满 50 减 5',
        discountAmount: '5.00',
        minSpend: '50.00',
        // Already spent on an earlier order.
        status: 'used',
        usedAt: new Date('2026-05-01T00:00:00.000Z'),
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validTo: new Date('2026-12-31T00:00:00.000Z'),
      })
      .returning({ id: userCoupons.id });

    const { POST: create } = await import('./orders/route');
    const response = await create(
      json(
        'POST',
        '/api/v1/orders',
        {
          source: 'cart',
          idempotencyKey: 'ck-20260601-000007',
          userCouponId: String(spent!.id),
        },
        headers,
      ),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('COUPON_NOT_USABLE');
    expect(await harness.ctx.db.select().from(orders)).toHaveLength(0);
    const skus = await harness.ctx.db
      .select({ id: productSkus.id, stock: productSkus.stock })
      .from(productSkus);
    expect(skus.find((row) => row.id === item.skuId)?.stock).toBe(10);
    const wallet = await harness.ctx.db
      .select({ id: userCoupons.id, status: userCoupons.status })
      .from(userCoupons);
    expect(wallet.find((row) => row.id === spent!.id)?.status).toBe('used');
  });

  it('puts 再次购买 back into the cart', async () => {
    const { headers } = await cartWithOneItem();
    const { POST: create } = await import('./orders/route');
    const created = await create(
      json(
        'POST',
        '/api/v1/orders',
        { source: 'cart', idempotencyKey: 'ck-20260601-000006' },
        headers,
      ),
    );
    const orderId = (await created.json()).id as string;

    const { POST: rebuyRoute } = await import('./cart/rebuys/route');
    const response = await rebuyRoute(json('POST', '/api/v1/cart/rebuys', { orderId }, headers));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ added: 1, skippedSkuIds: [] });
  });
});
