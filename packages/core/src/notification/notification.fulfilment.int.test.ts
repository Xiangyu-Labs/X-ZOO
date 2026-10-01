import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { cartItems } from '@shop/db/schema/cart';
import { productSkus, productVirtualCards, products } from '@shop/db/schema/catalog';
import { notificationMessages } from '@shop/db/schema/notification';
import { orderItems } from '@shop/db/schema/order';
import { expressCompanies } from '@shop/db/schema/reference';
import { admins } from '@shop/db/schema/auth';
import { effects } from '@shop/db/schema/system';
import { userAddresses, users } from '@shop/db/schema/user';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { registerCatalogDomain } from '../catalog';
import { drainEffects, recordEffect } from '../effects';
import type { Actor, Ctx } from '../kernel/context';
import { Money } from '../kernel/money';
import { withTx } from '../kernel/tx';
import * as order from '../order';
import {
  onOrderPaid,
  onOrderRefunded,
  registerOrderStateMachine,
  resetOrderPorts,
} from '../order/ports';
import { registerShippingFreightPort } from '../shipping';
import { registerNotificationDomain } from './index';
import { findNotificationEvent } from './notification.registry';
import { placeholdersIn } from './notification.render';
// The `notification.send` handler registers at import time.
import './notification.effects';

/**
 * NOTIF-007: what a message says is what its sender carried.
 *
 * The fulfilment effects (`shipment.dispatched`, `order.received`) carry ids
 * only, and rows of that shape are already in the ledger; the order number, the
 * carrier and the tracking number are read by the handler when it runs. These
 * tests drive the real flow — checkout, 发货, 确认收货 — through the ledger and
 * read the 站内信 the buyer ends up with.
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
  // The per-channel claims live in Redis and the ids restart with the tables.
  await harness.redis.flushdb();
  harness.clock.set(NOW);
  harness.queue.reset();
  resetOrderPorts();
  order.resetFulfilmentPorts();
  registerCatalogDomain();
  registerShippingFreightPort();
  registerOrderStateMachine(order.orderStateMachine);
  order.installFulfilmentHooks();
  registerNotificationDomain();
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

async function makeProduct(
  kind: 'physical' | 'virtual_card' = 'physical',
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
  if (kind === 'virtual_card') {
    await harness.ctx.db.insert(productVirtualCards).values({
      productId: product!.id,
      skuId: sku!.id,
      cardKey: `KEY-${sequence}`,
      cardNo: `NO-${sequence}`,
      cardSecret: `SEC-${sequence}`,
    });
  }
  return { productId: product!.id, skuId: sku!.id };
}

async function makeExpressCompany(): Promise<number> {
  const [row] = await harness.ctx.db
    .insert(expressCompanies)
    .values({ code: `sf-${(sequence += 1)}`, name: '顺丰速运' })
    .returning({ id: expressCompanies.id });
  return row!.id;
}

interface Placed {
  userId: number;
  orderId: number;
  orderNo: string;
  itemIds: number[];
}

/** A paid order, one line per product, the paid hooks run as the payment domain runs them. */
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
    idempotencyKey: `nf-${(sequence += 1).toString().padStart(10, '0')}`,
  });
  const orderId = Number(detail.id);
  await withTx(harness.ctx.db, async (tx) => {
    await order.orderStateMachine.transition(tx, orderId, ['pending_payment'], 'paid', {
      at: harness.ctx.clock.now(),
      paidAmount: '60.00',
      transactionNo: `WX-${orderId}`,
    });
    await onOrderPaid.dispatch(tx, harness.ctx, {
      orderId,
      orderNo: detail.orderNo,
      userId,
      paidAmount: Money.parse('60.00'),
      at: harness.ctx.clock.now(),
      transactionId: `WX-${orderId}`,
    });
  });
  const items = await harness.ctx.db
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(orderItems.id);
  return { userId, orderId, orderNo: detail.orderNo, itemIds: items.map((item) => item.id) };
}

const drain = () => drainEffects(harness.ctx, { baseBackoffMs: 0, maxBackoffMs: 0 });

async function inbox(userId: number, code: string) {
  return harness.ctx.db
    .select()
    .from(notificationMessages)
    .where(and(eq(notificationMessages.userId, userId), eq(notificationMessages.code, code)))
    .orderBy(notificationMessages.id);
}

/** The placeholders of an event's default wording that `data` leaves blank. */
function blankIn(code: string, data: Record<string, unknown>): string[] {
  const event = findNotificationEvent(code)!;
  return placeholdersIn(`${event.defaults.title} ${event.defaults.body}`).filter(
    (name) => data[name] === undefined || data[name] === null || data[name] === '',
  );
}

async function notificationPayload(scopeId: string) {
  const [row] = await harness.ctx.db
    .select()
    .from(effects)
    .where(and(eq(effects.scope, 'notification'), eq(effects.scopeId, scopeId)));
  return row?.payload as { data: Record<string, unknown> } | undefined;
}

// ---------------------------------------------------------------------------
// the tests
// ---------------------------------------------------------------------------

describe('NOTIF-007 — the fulfilment messages carry what their wording names', () => {
  it('tells the buyer the order number, the carrier and the tracking number of an express parcel', async () => {
    const placed = await paidOrder([await makeProduct()]);
    const company = await makeExpressCompany();
    await order.adminShip(
      asAdmin(await makeAdmin()),
      { id: String(placed.orderId) },
      {
        deliveryMode: 'express',
        expressCompanyId: String(company),
        trackingNo: 'SF1234567890',
        lines: [],
      },
    );
    await drain();

    const [message] = await inbox(placed.userId, 'order_shipped');
    expect(message?.content).toBe(`订单 ${placed.orderNo} 已发货，顺丰速运 运单号 SF1234567890。`);
    expect(message?.data).toMatchObject({
      orderNo: placed.orderNo,
      company: '顺丰速运',
      trackingNo: 'SF1234567890',
      amount: '60.00',
      route: { route: 'order', params: { id: String(placed.orderId) } },
    });
  });

  it('reads the facts when the handler runs, so a row that carries ids only is told in full', async () => {
    // What every `shipment.dispatched` row in the ledger looks like, including
    // those recorded before the handler learned to read the order: ids only.
    const placed = await paidOrder([await makeProduct()]);
    const company = await makeExpressCompany();
    const shipment = await order.adminShip(
      asAdmin(await makeAdmin()),
      { id: String(placed.orderId) },
      { deliveryMode: 'express', expressCompanyId: String(company), trackingNo: 'SF1', lines: [] },
    );
    const [row] = await harness.ctx.db
      .select()
      .from(effects)
      .where(and(eq(effects.scope, 'shipment'), eq(effects.scopeId, shipment.id)));
    expect(row?.payload).toEqual({
      orderId: placed.orderId,
      userId: placed.userId,
      shipmentId: Number(shipment.id),
    });

    // 修改发货信息 before the dispatcher got to it: the message names the
    // corrected number, not the one typed first.
    await order.updateShipment(
      asAdmin(await makeAdmin()),
      { id: shipment.id },
      { trackingNo: 'SF2' },
    );
    await drain();

    const [message] = await inbox(placed.userId, 'order_shipped');
    expect(message?.content).toBe(`订单 ${placed.orderNo} 已发货，顺丰速运 运单号 SF2。`);
  });

  it('tells a buyer whose order ships in two parcels about each of them', async () => {
    const placed = await paidOrder([await makeProduct(), await makeProduct()]);
    const company = await makeExpressCompany();
    const adminId = await makeAdmin();
    for (const [index, itemId] of placed.itemIds.entries()) {
      await order.adminShip(
        asAdmin(adminId),
        { id: String(placed.orderId) },
        {
          deliveryMode: 'express',
          expressCompanyId: String(company),
          trackingNo: `SF-PART-${index + 1}`,
          lines: [{ orderItemId: String(itemId), quantity: 1 }],
        },
      );
    }
    await drain();
    // A replayed dispatch is still one message per parcel (NOTIF-002).
    await drain();

    const messages = await inbox(placed.userId, 'order_shipped');
    expect(messages.map((message) => message.data?.['trackingNo'])).toEqual([
      'SF-PART-1',
      'SF-PART-2',
    ]);
  });

  it('says 商家配送 and the courier for a parcel the shop delivers itself', async () => {
    const placed = await paidOrder([await makeProduct()]);
    await order.adminShip(
      asAdmin(await makeAdmin()),
      { id: String(placed.orderId) },
      {
        deliveryMode: 'merchant_delivery',
        courierName: '王师傅',
        courierPhone: '13900139000',
        lines: [],
      },
    );
    await drain();

    const [message] = await inbox(placed.userId, 'order_shipped');
    expect(message?.content).toBe(
      `订单 ${placed.orderNo} 已发货，由商家配送，配送员 王师傅 13900139000。`,
    );
  });

  it('says the goods were handed over for an automatic virtual delivery', async () => {
    const placed = await paidOrder([await makeProduct('virtual_card')]);
    await drain();

    const [message] = await inbox(placed.userId, 'order_shipped');
    expect(message?.content).toBe(
      `订单 ${placed.orderNo} 已发货，虚拟商品已发放，可在订单详情中查看。`,
    );
  });

  it('does not announce a parcel cancelled before the dispatcher reached it', async () => {
    // A partial shipment: only a parcel of an order still in 待发货 can be cancelled.
    const placed = await paidOrder([await makeProduct(), await makeProduct()]);
    const company = await makeExpressCompany();
    const adminId = await makeAdmin();
    const shipment = await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      {
        deliveryMode: 'express',
        expressCompanyId: String(company),
        trackingNo: 'SF9',
        lines: [{ orderItemId: String(placed.itemIds[0]), quantity: 1 }],
      },
    );
    await order.cancelShipment(asAdmin(adminId), { id: shipment.id }, { reason: '填错了' });
    await drain();

    expect(await inbox(placed.userId, 'order_shipped')).toEqual([]);
  });

  it('names the order in 确认收货', async () => {
    const placed = await paidOrder([await makeProduct()]);
    const company = await makeExpressCompany();
    await order.adminShip(
      asAdmin(await makeAdmin()),
      { id: String(placed.orderId) },
      { deliveryMode: 'express', expressCompanyId: String(company), trackingNo: 'SF7', lines: [] },
    );
    await order.confirmReceipt(as(placed.userId), { id: String(placed.orderId) });
    await drain();

    const [message] = await inbox(placed.userId, 'order_received');
    expect(message?.content).toBe(`订单 ${placed.orderNo} 已确认收货，感谢您的购买。`);
  });

  it('NOTIF-009 — tells the admins 用户已确认收货, with the order number and amount', async () => {
    const placed = await paidOrder([await makeProduct()]);
    const company = await makeExpressCompany();
    await order.adminShip(
      asAdmin(await makeAdmin()),
      { id: String(placed.orderId) },
      { deliveryMode: 'express', expressCompanyId: String(company), trackingNo: 'SF9', lines: [] },
    );
    await order.confirmReceipt(as(placed.userId), { id: String(placed.orderId) });
    await drain();

    const payload = await notificationPayload(`admin_order_received:order:${placed.orderId}`);
    expect(payload?.data).toMatchObject({ orderNo: placed.orderNo });
    expect(payload?.data['amount']).not.toBe('');
    expect(blankIn('admin_order_received', payload!.data)).toEqual([]);
  });
});

describe('NOTIF-007 — the order hooks carry what their wording names', () => {
  it('gives 支付成功 its payment time and 退款到账 its refund number', async () => {
    const placed = await paidOrder([await makeProduct()]);
    const paid = await notificationPayload(`order_paid:order:${placed.orderId}`);
    expect(paid?.data).toMatchObject({ orderNo: placed.orderNo, paidAt: '2026-06-01 08:00' });
    expect(blankIn('order_paid', paid!.data)).toEqual([]);

    await withTx(harness.ctx.db, (tx) =>
      onOrderRefunded.dispatch(tx, harness.ctx, {
        orderId: placed.orderId,
        orderNo: placed.orderNo,
        userId: placed.userId,
        at: harness.ctx.clock.now(),
        refundId: 77,
        refundNo: 'RF202606010001',
        refundedAmount: Money.parse('60.00'),
        partial: false,
      }),
    );
    const settled = await notificationPayload('refund_settled:refund:77');
    expect(settled?.data).toMatchObject({
      refundNo: 'RF202606010001',
      amount: '60.00',
      refundNote: '的 ¥60.00 已原路退回',
    });
    expect(blankIn('refund_settled', settled!.data)).toEqual([]);
  });

  it('leaves no placeholder of the order events’ default wording blank', async () => {
    const placed = await paidOrder([await makeProduct()]);
    const company = await makeExpressCompany();
    await order.adminShip(
      asAdmin(await makeAdmin()),
      { id: String(placed.orderId) },
      { deliveryMode: 'express', expressCompanyId: String(company), trackingNo: 'SF8', lines: [] },
    );
    await order.confirmReceipt(as(placed.userId), { id: String(placed.orderId) });
    await drain();

    const rows = await harness.ctx.db
      .select()
      .from(effects)
      .where(eq(effects.scope, 'notification'));
    const sent = rows.map((row) => row.payload as { event: string; data: Record<string, unknown> });
    expect(sent.map((payload) => payload.event).sort()).toEqual([
      'admin_order_created',
      'admin_order_paid',
      'admin_order_received',
      'order_created',
      'order_paid',
      'order_received',
      'order_shipped',
    ]);
    for (const payload of sent) {
      expect(blankIn(payload.event, payload.data), payload.event).toEqual([]);
    }
  });
});

describe('NOTIF-007 — an old ledger row', () => {
  it('is told in full when it carries nothing but the order id', async () => {
    const placed = await paidOrder([await makeProduct()]);
    await withTx(harness.ctx.db, async (tx) => {
      await recordEffect(tx, harness.ctx, {
        scope: 'order',
        scopeId: String(placed.orderId),
        eventType: 'order.received',
        payload: { orderId: placed.orderId },
      });
    });
    await drain();

    const [message] = await inbox(placed.userId, 'order_received');
    expect(message?.content).toBe(`订单 ${placed.orderNo} 已确认收货，感谢您的购买。`);
  });
});
