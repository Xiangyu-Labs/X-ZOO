import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminRoles, admins, auditLogs, rolePermissions, roles } from '@shop/db/schema/auth';
import { productSkus, products } from '@shop/db/schema/catalog';
import { cartItems } from '@shop/db/schema/cart';
import { orderItems, orders } from '@shop/db/schema/order';
import { expressCompanies } from '@shop/db/schema/reference';
import { userAddresses, users } from '@shop/db/schema/user';
import {
  AdminAuthService,
  hashPassword,
  registerUserLookup,
  resetUserLookup,
  UserSessionService,
} from '@shop/core/auth';
import * as order from '@shop/core/order';
import { createTestCtx, fakeUserLookup, type TestCtx } from '@shop/testing';
import { ADMIN_COOKIE } from '../../../src/server/handle';
import { setContainer, type Container } from '../../../src/server/container';
import type { Env } from '../../../src/server/env';

/**
 * Fulfilment, the console and invoices as HTTP.
 *
 * The behaviour itself is pinned down in `@shop/core`; what is proved here is
 * only what a route file can get wrong — the contract bound to the wrong
 * method or path, `permission` not enforced before the service runs, a body
 * accepted before it was validated, a domain refusal answered with the wrong
 * status, and a write that never reached `audit_logs`.
 */

let harness: TestCtx;

const PASSWORD = 'xzoo123456';
const BCRYPT_COST = 4;
const ORIGIN = 'https://shop.example';
const NOW = '2026-06-01T00:00:00.000Z';

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
  harness = await createTestCtx({ now: NOW, platform: 'h5' });
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
  harness.clock.set(NOW);
  harness.queue.reset();
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

let sequence = 0;

/** Logs an operator in. With no list they are a super admin. */
async function adminCookie(permissions?: string[]): Promise<Record<string, string>> {
  sequence += 1;
  const account = `operator-${sequence}`;
  const [admin] = await harness.ctx.db
    .insert(admins)
    .values({
      account,
      passwordHash: await hashPassword(PASSWORD, BCRYPT_COST),
      name: '运营',
      isSuper: permissions === undefined,
    })
    .returning({ id: admins.id });

  if (permissions?.length) {
    const [role] = await harness.ctx.db
      .insert(roles)
      .values({ name: `role-${sequence}` })
      .returning({ id: roles.id });
    await harness.ctx.db.insert(adminRoles).values({ adminId: admin!.id, roleId: role!.id });
    await harness.ctx.db
      .insert(rolePermissions)
      .values(permissions.map((permission) => ({ roleId: role!.id, permission })));
  }

  const { POST: login } = await import('../auth/login/route');
  const response = await login(
    json('POST', '/admin-api/auth/login', { account, password: PASSWORD }),
  );
  const token = new RegExp(`${ADMIN_COOKIE}=([^;]+)`).exec(
    response.headers.get('set-cookie') ?? '',
  )?.[1];
  return { cookie: `${ADMIN_COOKIE}=${token}` };
}

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
  return {
    userId: user!.id,
    headers: { authorization: `Bearer ${issued.token}`, 'x-client-platform': 'h5' },
  };
}

interface Placed {
  userId: number;
  headers: Record<string, string>;
  orderId: number;
  itemIds: number[];
}

/** A paid order placed by a real storefront session. */
async function paidOrder(): Promise<Placed> {
  const { userId, headers } = await shopper();
  sequence += 1;
  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `商品${sequence}`,
      status: 'on_shelf',
      imageUrl: 'https://cdn.example.com/p.jpg',
      price: '60.00',
      stock: 50,
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
      stock: 50,
      isDefault: true,
    })
    .returning({ id: productSkus.id });
  await harness.ctx.db
    .insert(cartItems)
    .values({ userId, productId: product!.id, skuId: sku!.id, quantity: 1, isSelected: true });

  const { POST } = await import('../../api/v1/orders/route');
  const created = await POST(
    json(
      'POST',
      '/api/v1/orders',
      { source: 'cart', idempotencyKey: `http-20260601-${String(sequence).padStart(6, '0')}` },
      headers,
    ),
  );
  expect(created.status).toBe(201);
  const orderId = Number((await created.json()).id);

  await harness.ctx.withTx(async (tx) => {
    const moved = await order.orderStateMachine.transition(
      tx,
      orderId,
      ['pending_payment'],
      'paid',
      { at: harness.ctx.clock.now(), paidAmount: '60.00', transactionNo: `WX-${orderId}` },
    );
    if (!moved.won) throw new Error('could not pay');
  });

  const items = await harness.ctx.db.select().from(orderItems);
  harness.queue.reset();
  return {
    userId,
    headers,
    orderId,
    itemIds: items.filter((item) => item.orderId === orderId).map((item) => item.id),
  };
}

async function orderById(orderId: number) {
  const rows = await harness.ctx.db.select().from(orders);
  return rows.find((row) => row.id === orderId)!;
}

async function makeExpressCompany(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(expressCompanies)
    .values({ code: `sf-${sequence}`, name: `顺丰${sequence}` })
    .returning({ id: expressCompanies.id });
  return row!.id;
}

// ---------------------------------------------------------------------------
// the console
// ---------------------------------------------------------------------------

describe('/admin-api/orders', () => {
  it('401s without a session', async () => {
    const { GET } = await import('./route');
    const response = await GET(get('/admin-api/orders?page=1&pageSize=20'));
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('UNAUTHENTICATED');
  });

  it('403s an operator who may not read orders', async () => {
    const headers = await adminCookie(['order:shipment:write']);
    const { GET } = await import('./route');
    const response = await GET(get('/admin-api/orders?page=1&pageSize=20', headers));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('FORBIDDEN');
  });

  it('lists with 200 and a body the contract accepts', async () => {
    const headers = await adminCookie(['order:order:read']);
    const placed = await paidOrder();

    const { GET } = await import('./route');
    const response = await GET(get('/admin-api/orders?page=1&pageSize=20&status=paid', headers));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe(String(placed.orderId));
  });

  it('refuses a query the schema does not accept', async () => {
    const headers = await adminCookie();
    const { GET } = await import('./route');
    const response = await GET(get('/admin-api/orders?page=0&pageSize=20', headers));
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /admin-api/orders/:id/shipments', () => {
  it('dispatches with 201 and writes an audit entry', async () => {
    const headers = await adminCookie(['order:shipment:write']);
    const placed = await paidOrder();
    const company = await makeExpressCompany();

    const { POST } = await import('./[id]/shipments/route');
    const response = await POST(
      json(
        'POST',
        `/admin-api/orders/${placed.orderId}/shipments`,
        {
          deliveryMode: 'express',
          expressCompanyId: String(company),
          trackingNo: 'SF123456789',
          lines: [],
        },
        headers,
      ),
      { params: Promise.resolve({ id: String(placed.orderId) }) },
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.deliveryMode).toBe('express');
    expect(body.trackingNo).toBe('SF123456789');

    expect((await orderById(placed.orderId)).status).toBe('shipped');

    const audit = (await harness.ctx.db.select().from(auditLogs)).filter(
      // Sign-ins are audited too; this test is about the operation.
      (row) => row.routeId !== 'auth.adminLogin',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.target).toBe(`order:${placed.orderId}`);
  });

  it('403s an operator who may read but not ship', async () => {
    const headers = await adminCookie(['order:order:read']);
    const placed = await paidOrder();
    const company = await makeExpressCompany();

    const { POST } = await import('./[id]/shipments/route');
    const response = await POST(
      json(
        'POST',
        `/admin-api/orders/${placed.orderId}/shipments`,
        {
          deliveryMode: 'express',
          expressCompanyId: String(company),
          trackingNo: 'SF1',
          lines: [],
        },
        headers,
      ),
      { params: Promise.resolve({ id: String(placed.orderId) }) },
    );
    expect(response.status).toBe(403);
    expect(
      (await harness.ctx.db.select().from(auditLogs)).filter(
        // Sign-ins are audited too; this test is about the operation.
        (row) => row.routeId !== 'auth.adminLogin',
      ),
    ).toHaveLength(0);
  });

  it('refuses a malformed body before it writes anything', async () => {
    const headers = await adminCookie();
    const placed = await paidOrder();

    const { POST } = await import('./[id]/shipments/route');
    const response = await POST(
      json(
        'POST',
        `/admin-api/orders/${placed.orderId}/shipments`,
        { deliveryMode: 'teleport', lines: [] },
        headers,
      ),
      { params: Promise.resolve({ id: String(placed.orderId) }) },
    );
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe('VALIDATION_FAILED');
    expect((await orderById(placed.orderId)).status).toBe('paid');
  });

  it('turns a domain refusal into the status the contract declares', async () => {
    const headers = await adminCookie();
    const placed = await paidOrder();
    const company = await makeExpressCompany();
    const body = {
      deliveryMode: 'express',
      expressCompanyId: String(company),
      trackingNo: 'SF1',
      lines: [],
    };

    const { POST } = await import('./[id]/shipments/route');
    const params = { params: Promise.resolve({ id: String(placed.orderId) }) };
    expect(
      (
        await POST(
          json('POST', `/admin-api/orders/${placed.orderId}/shipments`, body, headers),
          params,
        )
      ).status,
    ).toBe(201);

    const second = await POST(
      json('POST', `/admin-api/orders/${placed.orderId}/shipments`, body, headers),
      { params: Promise.resolve({ id: String(placed.orderId) }) },
    );
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('ORDER_NOT_SHIPPABLE');
  });
});

describe('POST /admin-api/orders/:id/price', () => {
  const reprice = async (headers: Record<string, string>) => {
    const { POST } = await import('./[id]/price/route');
    return POST(
      json(
        'POST',
        '/admin-api/orders/999999/price',
        { operatorDiscount: '10.00', freightAmount: '0.00', reason: '老客户' },
        headers,
      ),
      { params: Promise.resolve({ id: '999999' }) },
    );
  };

  it('is money, so it has its own atom: 备注 and 修改地址 do not carry it', async () => {
    const response = await reprice(await adminCookie(['order:order:read', 'order:order:write']));
    expect(response.status).toBe(403);
    expect((await response.json()).details).toMatchObject({ permission: 'order:order:reprice' });
  });

  it('lets an operator holding 改价 through to the order', async () => {
    const response = await reprice(await adminCookie(['order:order:read', 'order:order:reprice']));
    expect(response.status).toBe(404);
  });
});

describe('GET /admin-api/orders/exports', () => {
  it('needs its own permission, and answers CSV text inside the envelope', async () => {
    await paidOrder();

    const reader = await adminCookie(['order:order:read']);
    const { GET } = await import('./exports/route');
    expect((await GET(get('/admin-api/orders/exports?kindOfExport=orders', reader))).status).toBe(
      403,
    );

    const exporter = await adminCookie(['order:order:export']);
    const response = await GET(get('/admin-api/orders/exports?kindOfExport=orders', exporter));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.contentType).toBe('text/csv');
    expect(body.content).toContain('订单号');
    expect(body.rowCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// invoices
// ---------------------------------------------------------------------------

describe('invoices over HTTP', () => {
  it('takes a request from the buyer and issues it from the console', async () => {
    const placed = await paidOrder();

    const { POST: request } = await import('../../api/v1/orders/[id]/invoice/route');
    const created = await request(
      json(
        'POST',
        `/api/v1/orders/${placed.orderId}/invoice`,
        { headerType: 'personal', invoiceType: 'plain', name: '张三' },
        placed.headers,
      ),
      { params: Promise.resolve({ id: String(placed.orderId) }) },
    );
    expect(created.status).toBe(201);
    const invoice = await created.json();
    expect(invoice.status).toBe('requested');

    const headers = await adminCookie(['order:invoice:read', 'order:invoice:write']);
    const { POST: issue } = await import('../order-invoices/[id]/issue/route');
    const issued = await issue(
      json(
        'POST',
        `/admin-api/order-invoices/${invoice.id}/issue`,
        { invoiceNumber: 'FP-0001' },
        headers,
      ),
      { params: Promise.resolve({ id: invoice.id }) },
    );
    expect(issued.status).toBe(200);
    expect(await issued.json()).toMatchObject({ status: 'issued', invoiceNumber: 'FP-0001' });

    const { GET: list } = await import('../order-invoices/route');
    const listed = await list(get('/admin-api/order-invoices?page=1&pageSize=20', headers));
    expect(listed.status).toBe(200);
    expect((await listed.json()).total).toBe(1);
  });

  it('401s a buyer with no session', async () => {
    const placed = await paidOrder();
    const { POST } = await import('../../api/v1/orders/[id]/invoice/route');
    const response = await POST(
      json('POST', `/api/v1/orders/${placed.orderId}/invoice`, {
        headerType: 'personal',
        invoiceType: 'plain',
        name: '张三',
      }),
      { params: Promise.resolve({ id: String(placed.orderId) }) },
    );
    expect(response.status).toBe(401);
  });
});
