import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { admins } from '@shop/db/schema/auth';
import { cartItems } from '@shop/db/schema/cart';
import { productSkus, products } from '@shop/db/schema/catalog';
import { orderStatusLogs, orders } from '@shop/db/schema/order';
import { expressCompanies } from '@shop/db/schema/reference';
import { userAddresses, users } from '@shop/db/schema/user';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { registerCatalogDomain } from '../catalog';
import { registerShippingFreightPort } from '../shipping';
import type { Actor, Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { Money } from '../kernel/money';
import { withTx } from '../kernel/tx';
import * as order from './index';
import { installFulfilmentHooks } from './order.fulfil.effects';
import { resetFulfilmentPorts } from './order.fulfil.ports';
import { orderStateMachine } from './order.state-machine';
import { onOrderPaid, registerOrderStateMachine, resetOrderPorts } from './ports';

/**
 * SMOKE-006 — 删除订单 over an order that got where it is the real way.
 *
 * `order.int.test.ts` › "hiding a finished order" covers the rule with orders
 * written straight into their terminal state, and its only refusal is an unpaid
 * order. This one is about the *shipped* refusal: a buyer must not be able to
 * swipe away an order that is on its way. So here the order is created, paid
 * (the state machine plus the paid hooks, as the payment callback does),
 * shipped by an admin, received by the buyer and completed by the review-window
 * job — and the delete is tried at each step that matters.
 */

let harness: TestCtx;

const NOW = '2026-06-01T00:00:00.000Z';
const DAY = 86_400_000;

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW, platform: 'h5' });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  harness.clock.set(NOW);
  harness.queue.reset();
  resetOrderPorts();
  registerCatalogDomain();
  registerShippingFreightPort();
  resetFulfilmentPorts();
  registerOrderStateMachine(orderStateMachine);
  installFulfilmentHooks();
});

let sequence = 0;

const as = (userId: number): Ctx =>
  harness.as({ kind: 'user', id: userId, permissions: [], isSuper: false } satisfies Actor);
const asAdmin = (adminId: number): Ctx =>
  harness.as({ kind: 'admin', id: adminId, permissions: [], isSuper: true } satisfies Actor);

async function makeUser(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({ account: `buyer-${sequence}` })
    .returning({ id: users.id });
  await harness.ctx.db.insert(userAddresses).values({
    userId: row!.id,
    receiverName: '张三',
    receiverPhone: '13800138000',
    provinceName: '浙江省',
    cityName: '杭州市',
    detail: '文三路 100 号',
    isDefault: true,
  });
  return row!.id;
}

/** A buyer with a paid, one-line physical order, and the admin who will ship it. */
async function paidOrder(): Promise<{ userId: number; orderId: number; adminId: number }> {
  sequence += 1;
  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `商品${sequence}`,
      kind: 'physical',
      status: 'on_shelf',
      imageUrl: 'https://cdn.example.com/p.jpg',
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

  const userId = await makeUser();
  await harness.ctx.db
    .insert(cartItems)
    .values({ userId, productId: product!.id, skuId: sku!.id, quantity: 1, isSelected: true });
  const created = await order.create(as(userId), {
    source: 'cart',
    cartItemIds: [],
    kind: 'normal',
    idempotencyKey: `smoke-006-${(sequence += 1).toString().padStart(8, '0')}`,
  });
  const orderId = Number(created.id);

  await withTx(harness.ctx.db, async (tx) => {
    const at = harness.ctx.clock.now();
    const moved = await orderStateMachine.transition(tx, orderId, ['pending_payment'], 'paid', {
      at,
      paidAmount: '60.00',
      transactionNo: `WX-${orderId}`,
    });
    if (!moved.won) throw new Error('could not mark the order paid');
    await onOrderPaid.dispatch(tx, harness.ctx, {
      orderId,
      orderNo: created.orderNo,
      userId,
      paidAmount: Money.parse('60.00'),
      at,
      transactionId: `WX-${orderId}`,
    });
  });

  const [admin] = await harness.ctx.db
    .insert(admins)
    .values({ account: `op-${sequence}`, passwordHash: 'x', name: `操作员${sequence}` })
    .returning({ id: admins.id });
  return { userId, orderId, adminId: admin!.id };
}

async function ship(orderId: number, adminId: number): Promise<void> {
  sequence += 1;
  const [company] = await harness.ctx.db
    .insert(expressCompanies)
    .values({ code: `sf-${sequence}`, name: `顺丰${sequence}` })
    .returning({ id: expressCompanies.id });
  await order.adminShip(
    asAdmin(adminId),
    { id: String(orderId) },
    {
      deliveryMode: 'express',
      expressCompanyId: String(company!.id),
      trackingNo: 'SF123456789',
      lines: [],
    },
  );
}

/** 确认收货, then the review window runs out and the completion job finishes it. */
async function receiveAndComplete(orderId: number, userId: number): Promise<void> {
  await order.confirmReceipt(as(userId), { id: String(orderId) });
  const { reviewWindowDays } = await harness.ctx.config.get(order.orderFulfilConfig);
  harness.clock.set(new Date(Date.parse(NOW) + (reviewWindowDays + 1) * DAY).toISOString());
  expect(await order.completeOrder(harness.ctx, { orderId })).toEqual({ completed: true });
}

const orderRow = async (orderId: number) =>
  (await harness.ctx.db.select().from(orders).where(eq(orders.id, orderId)))[0]!;

const hiddenLogs = async (orderId: number) =>
  (
    await harness.ctx.db.select().from(orderStatusLogs).where(eq(orderStatusLogs.orderId, orderId))
  ).filter((log) => log.changeType === 'hidden_by_user');

async function expectRefused(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, `expected ${code}, got success`).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
}

describe('SMOKE-006 — 删除订单 across a real order lifecycle', () => {
  it('refuses the owner while the order is shipped, and leaves it in their list', async () => {
    const { userId, orderId, adminId } = await paidOrder();
    await ship(orderId, adminId);
    expect((await orderRow(orderId)).status).toBe('shipped');

    await expectRefused(order.hide(as(userId), { id: String(orderId) }), 'ORDER_NOT_DELETABLE');

    expect((await orderRow(orderId)).hiddenByUserAt).toBeNull();
    expect(await hiddenLogs(orderId)).toEqual([]);
    const listed = await order.list(as(userId), {
      page: 1,
      pageSize: 20,
      tab: 'all',
      sortOrder: 'desc',
    });
    expect(listed.items.map((item) => item.id)).toEqual([String(orderId)]);
  });

  it('lets the owner delete it once it is finished', async () => {
    const { userId, orderId, adminId } = await paidOrder();
    await ship(orderId, adminId);
    await receiveAndComplete(orderId, userId);
    expect((await orderRow(orderId)).status).toBe('completed');

    expect(await order.hide(as(userId), { id: String(orderId) })).toEqual({ hidden: true });

    const row = await orderRow(orderId);
    expect(row.hiddenByUserAt).toBeInstanceOf(Date);
    // Deleted from the buyer's view only: the shop's record stays.
    expect(row.deletedAt).toBeNull();
    expect(row.status).toBe('completed');
    expect(await hiddenLogs(orderId)).toHaveLength(1);
    const listed = await order.list(as(userId), {
      page: 1,
      pageSize: 20,
      tab: 'all',
      sortOrder: 'desc',
    });
    expect(listed.total).toBe(0);
  });

  it('refuses a stranger the finished order, and leaves it with its owner', async () => {
    const { userId, orderId, adminId } = await paidOrder();
    await ship(orderId, adminId);
    await receiveAndComplete(orderId, userId);
    const stranger = await makeUser();

    await expectRefused(order.hide(as(stranger), { id: String(orderId) }), 'ORDER_NOT_FOUND');

    expect((await orderRow(orderId)).hiddenByUserAt).toBeNull();
    expect(await hiddenLogs(orderId)).toEqual([]);
    const listed = await order.list(as(userId), {
      page: 1,
      pageSize: 20,
      tab: 'all',
      sortOrder: 'desc',
    });
    expect(listed.total).toBe(1);
  });
});
