import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { productCategories, productCategoriesMap, products } from '@shop/db/schema/catalog';
import { couponTemplateCategories, couponTemplates, userCoupons } from '@shop/db/schema/coupon';
import { users } from '@shop/db/schema/user';
import {
  AdminAuthService,
  registerUserLookup,
  resetUserLookup,
  UserSessionService,
} from '@shop/core/auth';
import { createTestCtx, fakeUserLookup, type TestCtx } from '@shop/testing';
import { setContainer, type Container } from '../../../../../src/server/container';
import type { Env } from '../../../../../src/server/env';

/**
 * `POST /api/v1/user-coupons/applicable` as HTTP — the 确认订单 coupon picker.
 *
 * The confirm page holds no category ids for its lines, so a 品类券 would come
 * back greyed out for a cart in its category. The server looks each line's
 * categories up from `productId` and ignores any the body sends. What
 * is proved here is the wire: a body with no `categoryIds` is accepted, the
 * 品类券 is usable, and a body that *claims* a category does not make it so.
 * The container validates responses against the contract, as CI does.
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

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/v1/user-coupons/applicable`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      'x-client-platform': 'h5',
      ...headers,
    },
  });

let sequence = 0;

async function shopper(): Promise<{ userId: number; headers: Record<string, string> }> {
  sequence += 1;
  const [user] = await harness.ctx.db
    .insert(users)
    .values({ account: `shopper-${sequence}` })
    .returning({ id: users.id });
  registerUserLookup(fakeUserLookup([{ id: user!.id }]));
  const issued = await new UserSessionService().issue(harness.ctx, {
    userId: user!.id,
    passwordVersion: 1,
    platform: 'h5',
  });
  return { userId: user!.id, headers: { authorization: `Bearer ${issued.token}` } };
}

async function product(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(products)
    .values({
      name: `商品${sequence}`,
      status: 'on_shelf',
      imageUrl: 'https://cdn.example.com/p.jpg',
      freightMode: 'free',
    })
    .returning({ id: products.id });
  return row!.id;
}

/** A category holding `productId`. */
async function categoryOf(productId: number): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(productCategories)
    .values({ name: `分类${sequence}` })
    .returning({ id: productCategories.id });
  await harness.ctx.db.insert(productCategoriesMap).values({ productId, categoryId: row!.id });
  return row!.id;
}

/** A ¥15-off 品类券 on `categoryId`, already in `userId`'s wallet. */
async function categoryCoupon(userId: number, categoryId: number): Promise<number> {
  const [template] = await harness.ctx.db
    .insert(couponTemplates)
    .values({
      name: '母婴券',
      scope: 'categories',
      status: 'active',
      claimMode: 'manual',
      discountAmount: '15.00',
      minSpend: '0.00',
      validityMode: 'days_after_claim',
      validDays: 30,
      isUnlimitedSupply: true,
      perUserLimit: 1,
    })
    .returning({ id: couponTemplates.id });
  await harness.ctx.db
    .insert(couponTemplateCategories)
    .values({ templateId: template!.id, categoryId });
  const [held] = await harness.ctx.db
    .insert(userCoupons)
    .values({
      templateId: template!.id,
      userId,
      claimSlot: 1,
      sourceKind: 'claim',
      title: '母婴券',
      discountAmount: '15.00',
      minSpend: '0.00',
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validTo: new Date('2026-12-31T00:00:00.000Z'),
    })
    .returning({ id: userCoupons.id });
  return held!.id;
}

// ---------------------------------------------------------------------------
// the picker
// ---------------------------------------------------------------------------

describe('POST /api/v1/user-coupons/applicable — categories from the server', () => {
  it('offers a 品类券 for a cart in its category, with no categoryIds in the body', async () => {
    const { userId, headers } = await shopper();
    const [inCategory, elsewhere] = [await product(), await product()];
    const couponId = await categoryCoupon(userId, await categoryOf(inCategory));

    const { POST } = await import('./route');
    const response = await POST(
      post(
        {
          lines: [
            { productId: String(elsewhere), amount: '40.00' },
            { productId: String(inCategory), amount: '100.00' },
          ],
        },
        headers,
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.subtotal).toBe('140.00');
    expect(body.items).toEqual([
      expect.objectContaining({
        coupon: expect.objectContaining({ id: String(couponId), scope: 'categories' }),
        usable: true,
        discount: '15.00',
        eligibleLineIndexes: [1],
        reason: null,
      }),
    ]);
  });

  it('does not offer it when the body claims a category the product is not in', async () => {
    const { userId, headers } = await shopper();
    const [inCategory, elsewhere] = [await product(), await product()];
    const category = await categoryOf(inCategory);
    await categoryCoupon(userId, category);

    const { POST } = await import('./route');
    const response = await POST(
      post(
        {
          lines: [
            { productId: String(elsewhere), categoryIds: [String(category)], amount: '100.00' },
          ],
        },
        headers,
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toEqual([
      expect.objectContaining({
        usable: false,
        discount: '0.00',
        eligibleLineIndexes: [],
        reason: 'COUPON_NOT_APPLICABLE',
      }),
    ]);
  });

  it('401s without a session', async () => {
    const { POST } = await import('./route');
    const response = await POST(post({ lines: [{ productId: '1', amount: '1.00' }] }));
    expect(response.status).toBe(401);
  });
});
