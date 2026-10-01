import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { couponTemplates, userCoupons } from '@shop/db/schema/coupon';
import { orders } from '@shop/db/schema/order';
import { users } from '@shop/db/schema/user';
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
 * 订单赠券 as HTTP.
 *
 * `GET /api/v1/orders/:id/gift-coupons` is worth testing at this layer rather
 * than in `@shop/core`: it must answer a stranger with the same `404` as an
 * unknown id. A service test asserting `ORDER_NOT_FOUND` proves the throw; only
 * the HTTP round trip proves the *status*, and 403-vs-404 is the whole point —
 * a 403 would confirm the order exists.
 *
 * The container runs with `VALIDATE_RESPONSES` on, as CI does, so a response
 * that does not match the contract fails here rather than in a client.
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
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { headers: { 'x-client-platform': 'h5', ...headers } });

let sequence = 0;
const sessions = new UserSessionService();

/** Every user created so far, so `fakeUserLookup` keeps resolving the earlier ones. */
const known: { id: number }[] = [];

async function shopper(): Promise<{ userId: number; headers: Record<string, string> }> {
  sequence += 1;
  const [user] = await harness.ctx.db
    .insert(users)
    .values({ account: `shopper-${sequence}` })
    .returning({ id: users.id });
  known.push({ id: user!.id });
  registerUserLookup(fakeUserLookup([...known]));
  const issued = await sessions.issue(harness.ctx, {
    userId: user!.id,
    passwordVersion: 1,
    platform: 'h5',
  });
  return { userId: user!.id, headers: { authorization: `Bearer ${issued.token}` } };
}

async function makeOrder(userId: number): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(orders)
    .values({
      orderNo: `2026060100000${String(sequence).padStart(7, '0')}`,
      userId,
      platform: 'h5',
      status: 'paid',
      totalQuantity: 1,
      itemsAmount: '100.00',
      payableAmount: '100.00',
      // `orders_paid_shape`: anything past `pending_payment` carries both of these.
      paidAmount: '100.00',
      paidAt: new Date('2026-06-01T00:00:00.000Z'),
      receiverName: '张三',
      receiverPhone: '13800138000',
      receiverProvince: '浙江省',
      receiverCity: '杭州市',
      receiverDetail: '文三路 100 号',
    })
    .returning({ id: orders.id });
  return row!.id;
}

/** An `active` template with supply, which an order's gift coupons point at. */
async function makeTemplate(name: string, overrides: Record<string, unknown> = {}) {
  const [row] = await harness.ctx.db
    .insert(couponTemplates)
    .values({
      name,
      scope: 'all_products',
      claimMode: 'admin_grant',
      status: 'active',
      discountAmount: '10.00',
      minSpend: '100.00',
      validityMode: 'fixed_window',
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validTo: new Date('2026-12-31T00:00:00.000Z'),
      isUnlimitedSupply: false,
      totalCount: 100,
      remainingCount: 100,
      perUserLimit: 1,
      ...overrides,
    })
    .returning({ id: couponTemplates.id });
  return row!.id;
}

// ---------------------------------------------------------------------------
// 订单赠券
// ---------------------------------------------------------------------------

describe('GET /api/v1/orders/:id/gift-coupons', () => {
  it('401s without a session', async () => {
    const { GET } = await import('./orders/[id]/gift-coupons/route');
    const response = await GET(get('/api/v1/orders/1/gift-coupons'), {
      params: Promise.resolve({ id: '1' }),
    });
    expect(response.status).toBe(401);
  });

  it('lists the coupons the order earned', async () => {
    const buyer = await shopper();
    const orderId = await makeOrder(buyer.userId);
    const first = await makeTemplate('满 100 减 10');
    const second = await makeTemplate('满 200 减 30', {
      discountAmount: '30.00',
      minSpend: '200.00',
    });
    for (const [slot, templateId] of [first, second].entries()) {
      await harness.ctx.db.insert(userCoupons).values({
        templateId,
        userId: buyer.userId,
        claimSlot: slot + 1,
        title: `赠券 ${templateId}`,
        discountAmount: '10.00',
        minSpend: '100.00',
        sourceKind: 'gift_order',
        sourceOrderId: orderId,
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validTo: new Date('2026-12-31T00:00:00.000Z'),
      });
    }

    const { GET } = await import('./orders/[id]/gift-coupons/route');
    const response = await GET(get(`/api/v1/orders/${orderId}/gift-coupons`, buyer.headers), {
      params: Promise.resolve({ id: String(orderId) }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: { sourceKind: string }[] };
    expect(body.items).toHaveLength(2);
    expect(body.items.every((item) => item.sourceKind === 'gift_order')).toBe(true);
  });

  /** An order that earned nothing is a fact, not a failure — the page still asks. */
  it('answers an empty list rather than a 404 when the order earned nothing', async () => {
    const buyer = await shopper();
    const orderId = await makeOrder(buyer.userId);

    const { GET } = await import('./orders/[id]/gift-coupons/route');
    const response = await GET(get(`/api/v1/orders/${orderId}/gift-coupons`, buyer.headers), {
      params: Promise.resolve({ id: String(orderId) }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  });

  it('gives a stranger the same 404 as an unknown order', async () => {
    const buyer = await shopper();
    const orderId = await makeOrder(buyer.userId);
    const stranger = await shopper();

    const { GET } = await import('./orders/[id]/gift-coupons/route');
    const mine = await GET(get(`/api/v1/orders/${orderId}/gift-coupons`, stranger.headers), {
      params: Promise.resolve({ id: String(orderId) }),
    });
    const nobodys = await GET(get('/api/v1/orders/999999/gift-coupons', stranger.headers), {
      params: Promise.resolve({ id: '999999' }),
    });

    expect(mine.status).toBe(404);
    expect(nobodys.status).toBe(404);
    expect(await mine.json()).toEqual(await nobodys.json());
  });
});
