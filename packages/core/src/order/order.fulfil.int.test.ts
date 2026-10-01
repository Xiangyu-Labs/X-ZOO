import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { cartItems } from '@shop/db/schema/cart';
import { productSkus, productVirtualCards, products } from '@shop/db/schema/catalog';
import {
  orderItems,
  orderStatusLogs,
  orders,
  shipmentItems,
  shipments,
} from '@shop/db/schema/order';
import { expressCompanies } from '@shop/db/schema/reference';
import { admins } from '@shop/db/schema/auth';
import { userAddresses, users } from '@shop/db/schema/user';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { registerCatalogDomain } from '../catalog';
import { registerShippingFreightPort } from '../shipping';
import type { Actor, Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { withTx } from '../kernel/tx';
import { effects } from '@shop/db/schema/system';
import { drainEffects } from '../effects';
import * as order from './index';
import { autoDeliver, installFulfilmentHooks } from './order.fulfil.effects';
import { Money } from '../kernel/money';
import * as fulfilRepo from './order.fulfil.repo';
import { autoReceiveKey, completionKey } from './order.fulfil.service';
import { registerLogisticsPort, resetFulfilmentPorts } from './order.fulfil.ports';
import { orderStateMachine } from './order.state-machine';
import { onOrderPaid, registerOrderStateMachine, resetOrderPorts } from './ports';

/**
 * Fulfilment against a real PostgreSQL.
 *
 * Everything here is a property of a *transaction* or of a CHECK constraint,
 * which is why none of it can be a unit test: `shipped_quantity` is bounded by
 * the WHERE clause of its own UPDATE, `orders_fulfillment_matches_status` is
 * the database refusing a half-written roll-up, and the virtual delivery only
 * runs because the paid hook left a row in the effects ledger. The races live
 * next door in `order.fulfil.concurrency.int.test.ts`.
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
  harness.queue.reset();
  // `resetOrderPorts` empties the hook registries too, so the paid hook has to
  // go back in or every virtual order below would quietly skip delivery.
  resetOrderPorts();
  registerCatalogDomain();
  registerShippingFreightPort();
  resetFulfilmentPorts();
  registerOrderStateMachine(orderStateMachine);
  installFulfilmentHooks();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let sequence = 0;

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });
const adminActor = (id: number): Actor => ({ kind: 'admin', id, permissions: [], isSuper: true });

const as = (userId: number): Ctx => harness.as(userActor(userId));
const asAdmin = (adminId: number): Ctx => harness.as(adminActor(adminId));

async function makeAdmin(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(admins)
    .values({ account: `op-${sequence}`, passwordHash: 'x', name: `操作员${sequence}` })
    .returning({ id: admins.id });
  return row!.id;
}

async function makeUser(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({ account: `buyer-${sequence}` })
    .returning({ id: users.id });
  const userId = row!.id;
  await harness.ctx.db.insert(userAddresses).values({
    userId,
    receiverName: '张三',
    receiverPhone: '13800138000',
    provinceName: '浙江省',
    cityName: '杭州市',
    detail: '文三路 100 号',
    isDefault: true,
  });
  return userId;
}

type Kind = 'physical' | 'virtual_card' | 'virtual_coupon' | 'virtual_manual';

async function makeProduct(
  kind: Kind = 'physical',
  stock = 50,
): Promise<{ productId: number; skuId: number }> {
  sequence += 1;
  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `商品${sequence}`,
      kind,
      status: 'on_shelf',
      imageUrl: 'https://cdn.example.com/p.jpg',
      price: '60.00',
      stock,
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
      stock,
      isDefault: true,
    })
    .returning({ id: productSkus.id });
  return { productId: product!.id, skuId: sku!.id };
}

async function makeCards(line: { productId: number; skuId: number }, count: number): Promise<void> {
  if (count === 0) return;
  await harness.ctx.db.insert(productVirtualCards).values(
    Array.from({ length: count }, () => {
      sequence += 1;
      return {
        productId: line.productId,
        skuId: line.skuId,
        cardKey: `KEY-${sequence}`,
        cardNo: `NO-${sequence}`,
        cardSecret: `SEC-${sequence}`,
      };
    }),
  );
}

async function makeExpressCompany(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(expressCompanies)
    .values({ code: `sf-${sequence}`, name: `顺丰${sequence}` })
    .returning({ id: expressCompanies.id });
  return row!.id;
}

const key = () => `fulfil-${(sequence += 1).toString().padStart(10, '0')}`;

interface Placed {
  userId: number;
  orderId: number;
  itemIds: number[];
}

/** A paid order with one line per product handed in. */
async function paidOrder(
  lines: { productId: number; skuId: number; quantity?: number }[],
): Promise<Placed> {
  const userId = await makeUser();
  for (const line of lines) {
    await harness.ctx.db.insert(cartItems).values({
      userId,
      productId: line.productId,
      skuId: line.skuId,
      quantity: line.quantity ?? 1,
      isSelected: true,
    });
  }
  const detail = await order.create(as(userId), {
    source: 'cart',
    cartItemIds: [],
    kind: 'normal',
    idempotencyKey: key(),
  });
  const orderId = Number(detail.id);
  await markPaid(orderId);
  const items = await harness.ctx.db
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(orderItems.id);
  harness.queue.reset();
  return { userId, orderId, itemIds: items.map((item) => item.id) };
}

/** What the payment domain does when the callback lands, including the paid hooks. */
async function markPaid(orderId: number): Promise<void> {
  await withTx(harness.ctx.db, async (tx) => {
    const moved = await orderStateMachine.transition(tx, orderId, ['pending_payment'], 'paid', {
      at: harness.ctx.clock.now(),
      paidAmount: '60.00',
      transactionNo: `WX-${orderId}`,
    });
    if (!moved.won) throw new Error('could not mark the order paid');
    const [row] = await tx.select().from(orders).where(eq(orders.id, orderId));
    await onOrderPaid.dispatch(tx, harness.ctx, {
      orderId,
      orderNo: row!.orderNo,
      userId: row!.userId,
      paidAmount: Money.parse('60.00'),
      at: harness.ctx.clock.now(),
      transactionId: `WX-${orderId}`,
    });
  });
}

const orderRow = async (orderId: number) =>
  (await harness.ctx.db.select().from(orders).where(eq(orders.id, orderId)))[0]!;

const itemRow = async (id: number) =>
  (await harness.ctx.db.select().from(orderItems).where(eq(orderItems.id, id)))[0]!;

const logsOf = async (orderId: number) =>
  harness.ctx.db.select().from(orderStatusLogs).where(eq(orderStatusLogs.orderId, orderId));

async function expectDomainError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
  await promise.catch((error: unknown) => expect(DomainError.is(error)).toBe(true));
}

/**
 * Drizzle wraps a driver error and puts the query in the message, so the
 * constraint name is only on the cause. Asserting on it is the point: these
 * tests exist to prove the CHECK is really in the migration.
 */
async function expectConstraint(promise: Promise<unknown>, constraint: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error, `expected ${constraint} to refuse the write`).not.toBeNull();
  const cause = (error as { cause?: { constraint?: string } }).cause;
  expect(cause?.constraint).toBe(constraint);
}

const expressBody = (
  companyId: number,
  lines: { orderItemId: string; quantity: number }[] = [],
) => ({
  deliveryMode: 'express' as const,
  expressCompanyId: String(companyId),
  trackingNo: 'SF123456789',
  lines,
});

// ---------------------------------------------------------------------------
// 发货
// ---------------------------------------------------------------------------

describe('shipping a whole order', () => {
  it('writes one shipment, bumps every line and moves the order to shipped', async () => {
    const product = await makeProduct();
    const company = await makeExpressCompany();
    const placed = await paidOrder([{ ...product, quantity: 3 }]);
    const adminId = await makeAdmin();

    const shipment = await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      expressBody(company),
    );

    expect(shipment.deliveryMode).toBe('express');
    expect(shipment.status).toBe('dispatched');
    expect(shipment.expressCompanyName).toMatch(/^顺丰/);
    expect(shipment.shipmentNo.startsWith('SH')).toBe(true);
    expect(shipment.lines).toEqual([
      expect.objectContaining({ orderItemId: String(placed.itemIds[0]), quantity: 3 }),
    ]);

    const row = await orderRow(placed.orderId);
    expect(row.status).toBe('shipped');
    expect(row.fulfillmentStatus).toBe('fulfilled');
    expect(row.shippedAt).not.toBeNull();
    expect(row.autoReceiveAt).not.toBeNull();
    expect((await itemRow(placed.itemIds[0]!)).shippedQuantity).toBe(3);

    const logs = await logsOf(placed.orderId);
    const shippedLog = logs.find((log) => log.changeType === 'shipped');
    expect(shippedLog).toMatchObject({
      fromStatus: 'paid',
      toStatus: 'shipped',
      operatorKind: 'admin',
      operatorAdminId: adminId,
    });

    // Exactly one auto-receive, keyed so a second dispatch cannot queue another.
    const jobs = harness.queue.jobs.filter((job) => job.jobName === 'order.autoReceive');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.options.dedupeKey).toBe(autoReceiveKey(placed.orderId));
    expect(jobs[0]!.options.delay).toBe(10 * 86_400_000);
  });

  it('records the dispatch in the effects ledger for the notification domain', async () => {
    const product = await makeProduct();
    const company = await makeExpressCompany();
    const placed = await paidOrder([product]);
    const adminId = await makeAdmin();

    const shipment = await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      expressBody(company),
    );

    const rows = await harness.ctx.db
      .select()
      .from(effects)
      .where(and(eq(effects.scope, 'shipment'), eq(effects.scopeId, shipment.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventType).toBe('shipment.dispatched');

    // And with no notifier registered it still drains rather than parking a row
    // the operator cannot act on.
    const report = await drainEffects(harness.ctx, { baseBackoffMs: 0, maxBackoffMs: 0 });
    expect(report.parked).toBe(0);
    expect(report.retried).toBe(0);
  });
});

describe('shipping part of an order', () => {
  it('leaves it paid and partially_fulfilled until the last unit goes out', async () => {
    const first = await makeProduct();
    const second = await makeProduct();
    const company = await makeExpressCompany();
    const placed = await paidOrder([first, second]);
    const adminId = await makeAdmin();

    await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      expressBody(company, [{ orderItemId: String(placed.itemIds[0]), quantity: 1 }]),
    );

    let row = await orderRow(placed.orderId);
    expect(row.status).toBe('paid');
    expect(row.fulfillmentStatus).toBe('partially_fulfilled');
    expect(harness.queue.jobs.filter((job) => job.jobName === 'order.autoReceive')).toHaveLength(0);

    // 一键发货 with an empty body finishes what is left.
    await order.adminShip(asAdmin(adminId), { id: String(placed.orderId) }, expressBody(company));

    row = await orderRow(placed.orderId);
    expect(row.status).toBe('shipped');
    expect(row.fulfillmentStatus).toBe('fulfilled');
    expect(
      await order.orderConsole.adminShipments(asAdmin(adminId), { id: String(placed.orderId) }),
    ).toMatchObject({ items: expect.any(Array) });
    expect((await fulfilRepo.listShipments(harness.ctx.db, [placed.orderId])).length).toBe(2);
    expect(harness.queue.jobs.filter((job) => job.jobName === 'order.autoReceive')).toHaveLength(1);
  });
});

describe('what shipping refuses', () => {
  it('refuses an order that has not been paid for', async () => {
    const product = await makeProduct();
    const company = await makeExpressCompany();
    const userId = await makeUser();
    await harness.ctx.db.insert(cartItems).values({
      userId,
      productId: product.productId,
      skuId: product.skuId,
      quantity: 1,
      isSelected: true,
    });
    const detail = await order.create(as(userId), {
      source: 'cart',
      cartItemIds: [],
      kind: 'normal',
      idempotencyKey: key(),
    });
    const adminId = await makeAdmin();

    await expectDomainError(
      order.adminShip(asAdmin(adminId), { id: detail.id }, expressBody(company)),
      'ORDER_NOT_SHIPPABLE',
    );
  });

  it('refuses an express dispatch with no carrier', async () => {
    const product = await makeProduct();
    const placed = await paidOrder([product]);
    const adminId = await makeAdmin();

    await expectDomainError(
      order.adminShip(
        asAdmin(adminId),
        { id: String(placed.orderId) },
        {
          deliveryMode: 'express',
          trackingNo: 'SF1',
          lines: [],
        },
      ),
      'ORDER_EXPRESS_COMPANY_NOT_FOUND',
    );
    // and one that names a carrier that does not exist
    await expectDomainError(
      order.adminShip(asAdmin(adminId), { id: String(placed.orderId) }, expressBody(999_999)),
      'ORDER_EXPRESS_COMPANY_NOT_FOUND',
    );
    expect(await harness.ctx.db.select().from(shipments)).toHaveLength(0);
  });

  it('refuses more units than the line has left, and writes nothing', async () => {
    const product = await makeProduct();
    const company = await makeExpressCompany();
    const placed = await paidOrder([{ ...product, quantity: 2 }]);
    const adminId = await makeAdmin();

    await expectDomainError(
      order.adminShip(
        asAdmin(adminId),
        { id: String(placed.orderId) },
        expressBody(company, [{ orderItemId: String(placed.itemIds[0]), quantity: 3 }]),
      ),
      'ORDER_SHIP_QUANTITY_EXCEEDED',
    );
    expect(await harness.ctx.db.select().from(shipments)).toHaveLength(0);
    expect((await itemRow(placed.itemIds[0]!)).shippedQuantity).toBe(0);
    expect((await orderRow(placed.orderId)).fulfillmentStatus).toBe('unfulfilled');
  });

  it('refuses a line that belongs to another order', async () => {
    const product = await makeProduct();
    const company = await makeExpressCompany();
    const placed = await paidOrder([product]);
    const other = await paidOrder([await makeProduct()]);
    const adminId = await makeAdmin();

    await expectDomainError(
      order.adminShip(
        asAdmin(adminId),
        { id: String(placed.orderId) },
        expressBody(company, [{ orderItemId: String(other.itemIds[0]), quantity: 1 }]),
      ),
      'ORDER_SHIP_LINE_INVALID',
    );
  });

  it('refuses to ship a card line by hand — the paid hook already delivered it', async () => {
    const card = await makeProduct('virtual_card');
    await makeCards(card, 1);
    const company = await makeExpressCompany();
    const placed = await paidOrder([card]);
    await drainEffects(harness.ctx, { baseBackoffMs: 0, maxBackoffMs: 0 });
    const adminId = await makeAdmin();

    await expectDomainError(
      order.adminShip(asAdmin(adminId), { id: String(placed.orderId) }, expressBody(company)),
      'ORDER_NOT_SHIPPABLE',
    );
  });
});

// ---------------------------------------------------------------------------
// 修改发货信息 / 撤销发货
// ---------------------------------------------------------------------------

describe('editing and cancelling a shipment', () => {
  async function shippedHalf(): Promise<{ placed: Placed; shipmentId: string; adminId: number }> {
    const first = await makeProduct();
    const second = await makeProduct();
    const company = await makeExpressCompany();
    const placed = await paidOrder([first, second]);
    const adminId = await makeAdmin();
    const shipment = await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      expressBody(company, [{ orderItemId: String(placed.itemIds[0]), quantity: 1 }]),
    );
    return { placed, shipmentId: shipment.id, adminId };
  }

  it('rewrites the waybill without touching which lines went out', async () => {
    const { shipmentId, adminId } = await shippedHalf();
    const updated = await order.updateShipment(
      asAdmin(adminId),
      { id: shipmentId },
      {
        trackingNo: 'SF-CORRECTED',
        remark: '单号打错了',
      },
    );
    expect(updated.trackingNo).toBe('SF-CORRECTED');
    expect(updated.lines).toHaveLength(1);
  });

  it('hands the units back and rolls the fulfilment status back with them', async () => {
    const { placed, shipmentId, adminId } = await shippedHalf();
    expect((await orderRow(placed.orderId)).fulfillmentStatus).toBe('partially_fulfilled');

    const cancelled = await order.cancelShipment(
      asAdmin(adminId),
      { id: shipmentId },
      {
        reason: '拣错货了',
      },
    );

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).not.toBeNull();
    expect((await itemRow(placed.itemIds[0]!)).shippedQuantity).toBe(0);
    expect((await orderRow(placed.orderId)).fulfillmentStatus).toBe('unfulfilled');
    expect(
      (await logsOf(placed.orderId)).some((log) => log.changeType === 'shipment_cancelled'),
    ).toBe(true);
  });

  it('refuses once the order has left paid, because there is no way back from shipped', async () => {
    const product = await makeProduct();
    const company = await makeExpressCompany();
    const placed = await paidOrder([product]);
    const adminId = await makeAdmin();
    const shipment = await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      expressBody(company),
    );
    expect((await orderRow(placed.orderId)).status).toBe('shipped');

    await expectDomainError(
      order.cancelShipment(asAdmin(adminId), { id: shipment.id }, {}),
      'ORDER_SHIPMENT_NOT_EDITABLE',
    );
  });

  it('refuses to cancel the same shipment twice', async () => {
    const { shipmentId, adminId } = await shippedHalf();
    await order.cancelShipment(asAdmin(adminId), { id: shipmentId }, {});
    await expectDomainError(
      order.cancelShipment(asAdmin(adminId), { id: shipmentId }, {}),
      'ORDER_SHIPMENT_NOT_EDITABLE',
    );
  });
});

// ---------------------------------------------------------------------------
// 物流查询
// ---------------------------------------------------------------------------

describe('tracking', () => {
  async function express(): Promise<{ shipmentId: string; userId: number; adminId: number }> {
    const product = await makeProduct();
    const company = await makeExpressCompany();
    const placed = await paidOrder([product]);
    const adminId = await makeAdmin();
    const shipment = await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      expressBody(company),
    );
    return { shipmentId: shipment.id, userId: placed.userId, adminId };
  }

  it('answers "unknown" rather than failing when no logistics provider is registered', async () => {
    const { shipmentId, adminId } = await express();
    const tracking = await order.adminTrackShipment(asAdmin(adminId), { id: shipmentId });
    expect(tracking).toMatchObject({ available: false, state: 'unknown', traces: [] });
    expect(tracking.trackingNo).toBe('SF123456789');
  });

  it('passes the carrier code, waybill and receiver phone to the port and returns its traces', async () => {
    const { shipmentId, adminId } = await express();
    const seen: { companyCode: string; trackingNo: string; phone?: string }[] = [];
    registerLogisticsPort({
      async track(_ctx, input) {
        seen.push(input);
        return {
          state: 'in_transit' as const,
          traces: [{ at: new Date(NOW), context: '已揽收' }],
        };
      },
    });

    const tracking = await order.adminTrackShipment(asAdmin(adminId), { id: shipmentId });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.trackingNo).toBe('SF123456789');
    // 顺丰 answers nothing without it.
    expect(seen[0]!.phone).toBe('13800138000');
    expect(tracking.available).toBe(true);
    expect(tracking.state).toBe('in_transit');
    expect(tracking.traces).toEqual([{ at: NOW, context: '已揽收' }]);
  });

  it('does not let a courier API outage take the order page down', async () => {
    const { shipmentId, adminId } = await express();
    registerLogisticsPort({
      async track() {
        throw new Error('快递 100 超时');
      },
    });
    const tracking = await order.adminTrackShipment(asAdmin(adminId), { id: shipmentId });
    expect(tracking).toMatchObject({ available: false, state: 'unknown' });
  });

  it('tells a stranger the parcel does not exist', async () => {
    const { shipmentId } = await express();
    const nosy = await makeUser();
    await expectDomainError(
      order.myShipmentTracking(as(nosy), { id: shipmentId }),
      'ORDER_SHIPMENT_NOT_FOUND',
    );
  });

  it('shows the buyer their own parcels', async () => {
    const product = await makeProduct();
    const company = await makeExpressCompany();
    const placed = await paidOrder([product]);
    const adminId = await makeAdmin();
    await order.adminShip(asAdmin(adminId), { id: String(placed.orderId) }, expressBody(company));

    const mine = await order.myShipments(as(placed.userId), { id: String(placed.orderId) });
    expect(mine.items).toHaveLength(1);
    await expectDomainError(
      order.myShipments(as(await makeUser()), { id: String(placed.orderId) }),
      'ORDER_NOT_FOUND',
    );
  });
});

// ---------------------------------------------------------------------------
// 确认收货 and completion
// ---------------------------------------------------------------------------

describe('receipt', () => {
  async function shipped(): Promise<Placed & { adminId: number }> {
    const product = await makeProduct();
    const company = await makeExpressCompany();
    const placed = await paidOrder([product]);
    const adminId = await makeAdmin();
    await order.adminShip(asAdmin(adminId), { id: String(placed.orderId) }, expressBody(company));
    return { ...placed, adminId };
  }

  it('moves shipped to received, marks the parcels delivered and schedules completion', async () => {
    const placed = await shipped();
    const detail = await order.confirmReceipt(as(placed.userId), { id: String(placed.orderId) });

    expect(detail.status).toBe('received');
    const row = await orderRow(placed.orderId);
    expect(row.receivedAt).not.toBeNull();
    expect(row.autoReceiveAt).toBeNull();

    const parcels = await harness.ctx.db
      .select()
      .from(shipments)
      .where(eq(shipments.orderId, placed.orderId));
    expect(parcels.every((parcel) => parcel.status === 'delivered')).toBe(true);

    // The auto-receive job is withdrawn and the completion job takes its place.
    expect(harness.queue.jobs.filter((job) => job.jobName === 'order.autoReceive')).toHaveLength(0);
    const completion = harness.queue.jobs.filter((job) => job.jobName === 'order.complete');
    expect(completion).toHaveLength(1);
    expect(completion[0]!.options.dedupeKey).toBe(completionKey(placed.orderId));
    expect(completion[0]!.options.delay).toBe(7 * 86_400_000);
  });

  it('refuses the buyer a second time, and refuses a stranger the first time', async () => {
    const placed = await shipped();
    await order.confirmReceipt(as(placed.userId), { id: String(placed.orderId) });
    await expectDomainError(
      order.confirmReceipt(as(placed.userId), { id: String(placed.orderId) }),
      'ORDER_NOT_RECEIVABLE',
    );
    await expectDomainError(
      order.confirmReceipt(as(await makeUser()), { id: String(placed.orderId) }),
      'ORDER_NOT_FOUND',
    );
  });

  /** ORDER-006: money that went back cannot be turned into a delivery. */
  it('refuses to confirm receipt of an order that was refunded', async () => {
    const placed = await shipped();
    await harness.ctx.db
      .update(orders)
      .set({ status: 'refunded', refundStatus: 'refunded', fulfillmentStatus: 'fulfilled' })
      .where(eq(orders.id, placed.orderId));

    await expectDomainError(
      order.confirmReceipt(as(placed.userId), { id: String(placed.orderId) }),
      'ORDER_NOT_RECEIVABLE',
    );
    expect((await orderRow(placed.orderId)).receivedAt).toBeNull();
    // The job simply finds nothing to do rather than erroring.
    expect(await order.autoReceive(harness.ctx, { orderId: placed.orderId })).toEqual({
      received: false,
    });
  });

  it('lets the operator confirm on the buyer’s behalf', async () => {
    const placed = await shipped();
    await order.orderConsole.adminConfirmReceipt(asAdmin(placed.adminId), {
      id: String(placed.orderId),
    });
    expect((await orderRow(placed.orderId)).status).toBe('received');
    const log = (await logsOf(placed.orderId)).find((entry) => entry.changeType === 'received');
    expect(log).toMatchObject({ operatorKind: 'admin', operatorAdminId: placed.adminId });
  });

  it('auto-receives silently, and a second pass is a no-op rather than an error', async () => {
    const placed = await shipped();
    expect(await order.autoReceive(harness.ctx, { orderId: placed.orderId })).toEqual({
      received: true,
    });
    expect(await order.autoReceive(harness.ctx, { orderId: placed.orderId })).toEqual({
      received: false,
    });
    const log = (await logsOf(placed.orderId)).filter(
      (entry) => entry.changeType === 'auto_received',
    );
    expect(log).toHaveLength(1);
    expect(log[0]!.operatorKind).toBe('system');
  });

  it('sweeps only the orders whose deadline has actually passed', async () => {
    const early = await shipped();
    expect(await order.sweepAutoReceive(harness.ctx)).toEqual({ scanned: 0, received: 0 });

    harness.clock.set('2026-06-12T00:00:00.000Z');
    expect(await order.sweepAutoReceive(harness.ctx)).toEqual({ scanned: 1, received: 1 });
    expect((await orderRow(early.orderId)).status).toBe('received');
  });
});

describe('completion', () => {
  async function received(): Promise<Placed> {
    const product = await makeProduct();
    const company = await makeExpressCompany();
    const placed = await paidOrder([product]);
    const adminId = await makeAdmin();
    await order.adminShip(asAdmin(adminId), { id: String(placed.orderId) }, expressBody(company));
    await order.confirmReceipt(as(placed.userId), { id: String(placed.orderId) });
    return placed;
  }

  it('waits out the review window before completing', async () => {
    const placed = await received();
    expect(await order.completeOrder(harness.ctx, { orderId: placed.orderId })).toEqual({
      completed: false,
    });
    expect((await orderRow(placed.orderId)).status).toBe('received');

    harness.clock.set('2026-06-09T00:00:00.000Z');
    expect(await order.completeOrder(harness.ctx, { orderId: placed.orderId })).toEqual({
      completed: true,
    });

    const row = await orderRow(placed.orderId);
    expect(row.status).toBe('completed');
    expect(row.completedAt).not.toBeNull();
    expect((await logsOf(placed.orderId)).some((log) => log.changeType === 'completed')).toBe(true);
  });

  it('is a no-op the second time, so a replayed job changes nothing', async () => {
    const placed = await received();
    harness.clock.set('2026-06-09T00:00:00.000Z');
    await order.completeOrder(harness.ctx, { orderId: placed.orderId });
    expect(await order.completeOrder(harness.ctx, { orderId: placed.orderId })).toEqual({
      completed: false,
    });
    expect(
      (await logsOf(placed.orderId)).filter((log) => log.changeType === 'completed'),
    ).toHaveLength(1);
  });

  it('sweeps the orders the delayed job lost', async () => {
    const placed = await received();
    expect(await order.sweepCompletions(harness.ctx)).toEqual({ scanned: 0, completed: 0 });
    harness.clock.set('2026-06-09T00:00:00.000Z');
    expect(await order.sweepCompletions(harness.ctx)).toEqual({ scanned: 1, completed: 1 });
    expect((await orderRow(placed.orderId)).status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// virtual delivery
// ---------------------------------------------------------------------------

describe('the paid hook and virtual delivery', () => {
  it('records one effect and nothing else inside the payment transaction', async () => {
    const card = await makeProduct('virtual_card');
    await makeCards(card, 1);
    const placed = await paidOrder([card]);

    // Before the ledger runs, the order is plain 待发货.
    const before = await orderRow(placed.orderId);
    expect(before.status).toBe('paid');
    expect(before.fulfillmentStatus).toBe('unfulfilled');
    expect(await harness.ctx.db.select().from(shipments)).toHaveLength(0);

    const pending = await harness.ctx.db
      .select()
      .from(effects)
      .where(and(eq(effects.scope, 'order'), eq(effects.scopeId, String(placed.orderId))));
    expect(pending.map((row) => row.eventType)).toEqual(['order.auto-deliver']);
  });

  it('hands over the card key, ships the order and says so on the timeline', async () => {
    const card = await makeProduct('virtual_card');
    await makeCards(card, 1);
    const placed = await paidOrder([card]);

    const outcome = await autoDeliver(harness.ctx, placed.orderId);
    expect(outcome.delivered).toBe(true);
    expect(outcome.fulfilled).toBe(true);
    expect(outcome.shortOfCards).toEqual([]);

    const row = await orderRow(placed.orderId);
    expect(row.status).toBe('shipped');
    expect(row.fulfillmentStatus).toBe('fulfilled');

    const [parcel] = await harness.ctx.db.select().from(shipments);
    expect(parcel!.deliveryMode).toBe('virtual');
    expect(parcel!.shipmentNo.startsWith('SV')).toBe(true);
    expect(parcel!.virtualContent).toContain('卡号');

    const [claimed] = await harness.ctx.db
      .select()
      .from(productVirtualCards)
      .where(eq(productVirtualCards.orderItemId, placed.itemIds[0]!));
    expect(claimed).toMatchObject({ state: 'claimed', claimedByUserId: placed.userId });

    const log = (await logsOf(placed.orderId)).find((e) => e.changeType === 'virtual_delivered');
    expect(log).toMatchObject({ operatorKind: 'system', toStatus: 'shipped' });
    expect(harness.queue.jobs.filter((job) => job.jobName === 'order.autoReceive')).toHaveLength(1);
  });

  it('runs exactly once however many times the ledger replays it', async () => {
    const card = await makeProduct('virtual_card');
    await makeCards(card, 3);
    const placed = await paidOrder([card]);

    await autoDeliver(harness.ctx, placed.orderId);
    const second = await autoDeliver(harness.ctx, placed.orderId);
    const third = await autoDeliver(harness.ctx, placed.orderId);

    expect(second.delivered).toBe(false);
    expect(third.delivered).toBe(false);
    expect(await harness.ctx.db.select().from(shipments)).toHaveLength(1);
    expect(
      await harness.ctx.db
        .select()
        .from(productVirtualCards)
        .where(eq(productVirtualCards.state, 'claimed')),
    ).toHaveLength(1);
  });

  it('runs through the ledger end to end when the dispatcher drains', async () => {
    const card = await makeProduct('virtual_card');
    await makeCards(card, 1);
    const placed = await paidOrder([card]);

    const report = await drainEffects(harness.ctx, { baseBackoffMs: 0, maxBackoffMs: 0 });
    expect(report.parked).toBe(0);
    expect((await orderRow(placed.orderId)).status).toBe('shipped');
  });

  it('leaves the order in 待发货 for an operator when the shop is out of cards', async () => {
    const card = await makeProduct('virtual_card');
    // no cards at all
    const placed = await paidOrder([card]);

    await expect(autoDeliver(harness.ctx, placed.orderId)).rejects.toThrow(/卡密库存不足/);

    // Nothing half-written: no shipment, no bumped line, still 待发货.
    expect(await harness.ctx.db.select().from(shipments)).toHaveLength(0);
    expect((await itemRow(placed.itemIds[0]!)).shippedQuantity).toBe(0);
    const row = await orderRow(placed.orderId);
    expect(row.status).toBe('paid');
    expect(row.fulfillmentStatus).toBe('unfulfilled');
  });

  it('delivers a coupon line without claiming anything', async () => {
    const coupon = await makeProduct('virtual_coupon');
    const placed = await paidOrder([coupon]);

    const outcome = await autoDeliver(harness.ctx, placed.orderId);
    expect(outcome.delivered).toBe(true);
    expect((await orderRow(placed.orderId)).status).toBe('shipped');
    const [parcel] = await harness.ctx.db.select().from(shipments);
    expect(parcel!.virtualContent).toContain('优惠券');
  });

  it('leaves the physical half of a mixed order for a human', async () => {
    const card = await makeProduct('virtual_card');
    await makeCards(card, 1);
    const physical = await makeProduct();
    const company = await makeExpressCompany();
    const placed = await paidOrder([card, physical]);

    const outcome = await autoDeliver(harness.ctx, placed.orderId);
    expect(outcome.delivered).toBe(true);
    expect(outcome.fulfilled).toBe(false);

    const row = await orderRow(placed.orderId);
    expect(row.status).toBe('paid');
    expect(row.fulfillmentStatus).toBe('partially_fulfilled');

    // 一键发货 now ships only what is left, and finishes the order.
    const adminId = await makeAdmin();
    const shipment = await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      expressBody(company),
    );
    expect(shipment.lines).toHaveLength(1);
    expect((await orderRow(placed.orderId)).status).toBe('shipped');
  });

  it('does not auto-ship a virtual_manual line — a human has to do something', async () => {
    const manual = await makeProduct('virtual_manual');
    const placed = await paidOrder([manual]);

    const outcome = await autoDeliver(harness.ctx, placed.orderId);
    expect(outcome.delivered).toBe(false);
    expect((await orderRow(placed.orderId)).status).toBe('paid');

    // It goes out through the normal button, as a virtual dispatch.
    const adminId = await makeAdmin();
    const shipment = await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      {
        deliveryMode: 'virtual',
        virtualContent: '已为您开通账号 abc',
        lines: [],
      },
    );
    expect(shipment.deliveryMode).toBe('virtual');
    expect((await orderRow(placed.orderId)).status).toBe('shipped');
  });

  it('hands nothing over once a refund has taken the order out of paid', async () => {
    const card = await makeProduct('virtual_card');
    await makeCards(card, 1);
    const placed = await paidOrder([card]);
    await harness.ctx.db
      .update(orders)
      .set({ status: 'refunded' })
      .where(eq(orders.id, placed.orderId));

    expect(await autoDeliver(harness.ctx, placed.orderId)).toMatchObject({ delivered: false });
    expect(await harness.ctx.db.select().from(shipments)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// shipment rows the CHECK constraints protect
// ---------------------------------------------------------------------------

describe('the database itself', () => {
  it('refuses an express shipment with no waybill', async () => {
    const product = await makeProduct();
    const placed = await paidOrder([product]);
    const company = await makeExpressCompany();
    await expectConstraint(
      harness.ctx.db.insert(shipments).values({
        orderId: placed.orderId,
        shipmentNo: 'SH-BAD',
        deliveryMode: 'express',
        status: 'dispatched',
        expressCompanyId: company,
        trackingNo: null,
        dispatchedAt: new Date(NOW),
      }),
      'shipments_express_needs_tracking',
    );
  });

  it('refuses to push a line past what was ordered', async () => {
    const product = await makeProduct();
    const placed = await paidOrder([{ ...product, quantity: 2 }]);
    await expectConstraint(
      harness.ctx.db
        .update(orderItems)
        .set({ shippedQuantity: 3 })
        .where(eq(orderItems.id, placed.itemIds[0]!)),
      'order_items_shipped_within_quantity',
    );
  });

  it('refuses a fulfilment status that contradicts the order status', async () => {
    const product = await makeProduct();
    const placed = await paidOrder([product]);
    await expectConstraint(
      harness.ctx.db
        .update(orders)
        .set({ status: 'shipped', fulfillmentStatus: 'unfulfilled' })
        .where(eq(orders.id, placed.orderId)),
      'orders_fulfillment_matches_status',
    );
  });

  it('keeps shipment_items in step with the shipment it belongs to', async () => {
    const product = await makeProduct();
    const company = await makeExpressCompany();
    const placed = await paidOrder([product]);
    const adminId = await makeAdmin();
    const shipment = await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      expressBody(company),
    );
    const lines = await harness.ctx.db
      .select()
      .from(shipmentItems)
      .where(eq(shipmentItems.shipmentId, Number(shipment.id)));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.orderItemId).toBe(placed.itemIds[0]);
  });
});
