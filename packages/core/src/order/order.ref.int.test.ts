import { orders } from '@shop/db/schema/order';
import { eq } from 'drizzle-orm';
import { users } from '@shop/db/schema/user';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { detail } from './order.query.service';
import { requireOrderRef, resolveOrderRef } from './order.ref';

/**
 * Order references against a real PostgreSQL: `:id` on a storefront order route
 * is the surrogate id **or** the 24-digit order number, and the owner is in the
 * WHERE either way.
 */

let harness: TestCtx;
const NOW = '2026-06-01T00:00:00.000Z';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW, platform: 'h5' });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  harness.clock.set(NOW);
});

let sequence = 0;

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });
const as = (userId: number): Ctx => harness.as(userActor(userId));

async function makeUser(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({ account: `buyer-${sequence}` })
    .returning({ id: users.id });
  return row!.id;
}

async function makeOrder(userId: number): Promise<{ id: number; orderNo: string }> {
  sequence += 1;
  const orderNo = `20260601000000${String(sequence).padStart(3, '0')}0000001`;
  const [row] = await harness.ctx.db
    .insert(orders)
    .values({
      orderNo,
      userId,
      platform: 'h5',
      status: 'pending_payment',
      totalQuantity: 1,
      itemsAmount: '60.00',
      payableAmount: '60.00',
      receiverName: '张三',
      receiverPhone: '13800138000',
      receiverProvince: '浙江省',
      receiverCity: '杭州市',
      receiverDetail: '文三路 100 号',
    })
    .returning({ id: orders.id });
  return { id: row!.id, orderNo };
}

async function expectDomainError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(DomainError.is(error) ? error.code : error).toBe(code);
}

describe('resolveOrderRef', () => {
  it('passes a surrogate id straight through', async () => {
    const userId = await makeUser();
    const order = await makeOrder(userId);
    expect(order.orderNo).toHaveLength(24);

    await expect(resolveOrderRef(harness.ctx.db, { ref: String(order.id), userId })).resolves.toBe(
      order.id,
    );
  });

  it('resolves an order number to the same order', async () => {
    const userId = await makeUser();
    const order = await makeOrder(userId);

    await expect(resolveOrderRef(harness.ctx.db, { ref: order.orderNo, userId })).resolves.toBe(
      order.id,
    );
  });

  it('answers null for a stranger — the same as for a number nobody was issued', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const order = await makeOrder(owner);

    await expect(
      resolveOrderRef(harness.ctx.db, { ref: order.orderNo, userId: stranger }),
    ).resolves.toBeNull();
    await expect(
      resolveOrderRef(harness.ctx.db, { ref: '202601010000009990000009', userId: stranger }),
    ).resolves.toBeNull();
  });

  it('hides an order the buyer hid from themselves', async () => {
    const userId = await makeUser();
    const order = await makeOrder(userId);
    await harness.ctx.db
      .update(orders)
      .set({ hiddenByUserAt: new Date(NOW) })
      .where(eq(orders.id, order.id));

    await expect(
      resolveOrderRef(harness.ctx.db, { ref: order.orderNo, userId }),
    ).resolves.toBeNull();
  });
});

describe('requireOrderRef', () => {
  it('turns an unresolvable reference into the calling domain’s own 404', async () => {
    const userId = await makeUser();
    await expectDomainError(
      requireOrderRef(as(userId), '202601010000009990000009'),
      'ORDER_NOT_FOUND',
    );
    await expectDomainError(
      requireOrderRef(as(userId), '202601010000009990000009', 'REFUND_ORDER_NOT_FOUND'),
      'REFUND_ORDER_NOT_FOUND',
    );
  });
});

describe('GET /api/v1/orders/:id', () => {
  it('answers to both references with the same order', async () => {
    const userId = await makeUser();
    const order = await makeOrder(userId);

    const byId = await detail(as(userId), { id: String(order.id) });
    const byNo = await detail(as(userId), { id: order.orderNo });

    expect(byId.id).toBe(String(order.id));
    expect(byNo).toEqual(byId);
    expect(byNo.orderNo).toBe(order.orderNo);
  });

  it('gives a stranger the same 404 for a number as for an id', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const order = await makeOrder(owner);

    await expectDomainError(detail(as(stranger), { id: order.orderNo }), 'ORDER_NOT_FOUND');
    await expectDomainError(detail(as(stranger), { id: String(order.id) }), 'ORDER_NOT_FOUND');
  });
});
