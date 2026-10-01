import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { cartItems } from '@shop/db/schema/cart';
import { productSkus, products } from '@shop/db/schema/catalog';
import { orderItems, orderStatusLogs, orders } from '@shop/db/schema/order';
import { expressCompanies } from '@shop/db/schema/reference';
import { refunds } from '@shop/db/schema/refund';
import { admins } from '@shop/db/schema/auth';
import { effects as effectsTable } from '@shop/db/schema/system';
import { userAddresses, users } from '@shop/db/schema/user';
import { createTestCtx, type TestCtx } from '@shop/testing';
import type { AdminOrderListQuery } from '@shop/contracts/order/order.fulfil.schemas';
import { registerCatalogDomain } from '../catalog';
import { registerNotificationDomain } from '../notification';
import { registerShippingFreightPort } from '../shipping';
import type { Actor, Ctx } from '../kernel/context';
import { Money } from '../kernel/money';
import { withTx } from '../kernel/tx';
import * as order from './index';
import { installFulfilmentHooks } from './order.fulfil.effects';
import { resetFulfilmentPorts } from './order.fulfil.ports';
import { orderStateMachine } from './order.state-machine';
import { orderPermissions } from './permissions';
import { onOrderPaid, registerOrderStateMachine, resetOrderPorts } from './ports';

/**
 * The admin order console, against a real PostgreSQL.
 *
 * The console has sharp edges, and each one has a case here: 改价 rewriting an
 * order somebody had already paid for, 修改地址 changing the label of a parcel
 * already in a van, and 删除订单 hiding a live order whose stock and money
 * stayed committed. All three are refused by WHERE clauses, which is precisely
 * why they need a database to test.
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
  resetOrderPorts();
  registerCatalogDomain();
  registerShippingFreightPort();
  resetFulfilmentPorts();
  // `resetOrderPorts` clears every hook registry, so the notification domain
  // is reinstalled with the rest. Without it `notify` drops the event — which
  // is the right behaviour for an unregistered code and would also make an
  // assertion here pass while proving nothing.
  registerNotificationDomain();
  registerOrderStateMachine(orderStateMachine);
  installFulfilmentHooks();
});

/** The 改价 notifications recorded so far, newest key last. */
async function priceChangeEffects() {
  const rows = await harness.ctx.db
    .select()
    .from(effectsTable)
    .where(eq(effectsTable.scope, 'notification'));
  return rows
    .filter((row) => row.scopeId.startsWith('order_price_changed:'))
    .sort((a, b) => a.scopeId.localeCompare(b.scopeId));
}

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

async function makeUser(nickname?: string): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({ account: `buyer-${sequence}`, ...(nickname ? { nickname } : {}) })
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

async function makeProduct(price = '60.00'): Promise<{ productId: number; skuId: number }> {
  sequence += 1;
  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `商品${sequence}`,
      status: 'on_shelf',
      imageUrl: 'https://cdn.example.com/p.jpg',
      price,
      stock: 100,
      freightMode: 'free',
    })
    .returning({ id: products.id });
  const [sku] = await harness.ctx.db
    .insert(productSkus)
    .values({
      productId: product!.id,
      skuCode: `SKU-${sequence}`,
      specText: '默认',
      price,
      stock: 100,
      isDefault: true,
    })
    .returning({ id: productSkus.id });
  return { productId: product!.id, skuId: sku!.id };
}

const key = () => `console-${(sequence += 1).toString().padStart(10, '0')}`;

interface Placed {
  userId: number;
  orderId: number;
  itemIds: number[];
}

async function placeOrder(
  options: { userId?: number; quantity?: number; price?: string } = {},
): Promise<Placed> {
  const userId = options.userId ?? (await makeUser());
  const product = await makeProduct(options.price);
  await harness.ctx.db.insert(cartItems).values({
    userId,
    productId: product.productId,
    skuId: product.skuId,
    quantity: options.quantity ?? 1,
    isSelected: true,
  });
  const detail = await order.create(as(userId), {
    source: 'cart',
    cartItemIds: [],
    kind: 'normal',
    idempotencyKey: key(),
  });
  const orderId = Number(detail.id);
  const items = await harness.ctx.db
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  return { userId, orderId, itemIds: items.map((item) => item.id) };
}

async function pay(placed: Placed, amount = '60.00'): Promise<void> {
  await withTx(harness.ctx.db, async (tx) => {
    const moved = await orderStateMachine.transition(
      tx,
      placed.orderId,
      ['pending_payment'],
      'paid',
      { at: harness.ctx.clock.now(), paidAmount: amount, transactionNo: `WX-${placed.orderId}` },
    );
    if (!moved.won) throw new Error('could not pay');
    const [row] = await tx.select().from(orders).where(eq(orders.id, placed.orderId));
    await onOrderPaid.dispatch(tx, harness.ctx, {
      orderId: placed.orderId,
      orderNo: row!.orderNo,
      userId: row!.userId,
      paidAmount: Money.parse(amount),
      at: harness.ctx.clock.now(),
    });
  });
  harness.queue.reset();
}

async function makeExpressCompany(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(expressCompanies)
    .values({ code: `sf-${sequence}`, name: `顺丰${sequence}` })
    .returning({ id: expressCompanies.id });
  return row!.id;
}

const orderRow = async (orderId: number) =>
  (await harness.ctx.db.select().from(orders).where(eq(orders.id, orderId)))[0]!;

const logsOf = async (orderId: number) =>
  harness.ctx.db.select().from(orderStatusLogs).where(eq(orderStatusLogs.orderId, orderId));

const listQuery = (over: Partial<AdminOrderListQuery> = {}): AdminOrderListQuery =>
  ({
    page: 1,
    pageSize: 20,
    sortBy: 'id',
    sortOrder: 'desc',
    ...over,
  }) as AdminOrderListQuery;

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

describe('the list', () => {
  it('pages, filters by status and carries the line items', async () => {
    const adminId = await makeAdmin();
    const pending = await placeOrder();
    const paid = await placeOrder();
    await pay(paid);

    const all = await order.orderConsole.adminList(asAdmin(adminId), listQuery());
    expect(all.total).toBe(2);
    expect(all.items[0]!.items.length).toBeGreaterThan(0);

    const onlyPaid = await order.orderConsole.adminList(
      asAdmin(adminId),
      listQuery({ status: ['paid'] }),
    );
    expect(onlyPaid.total).toBe(1);
    expect(onlyPaid.items[0]!.id).toBe(String(paid.orderId));

    const firstPage = await order.orderConsole.adminList(
      asAdmin(adminId),
      listQuery({ pageSize: 1 }),
    );
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.total).toBe(2);
    expect(String(pending.orderId)).toBeTruthy();
  });

  it('finds an order by its number', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    const row = await orderRow(placed.orderId);

    const found = await order.orderConsole.adminList(
      asAdmin(adminId),
      listQuery({ keyword: row.orderNo }),
    );
    expect(found.total).toBe(1);
    expect(found.items[0]!.orderNo).toBe(row.orderNo);

    // `%` and `_` are literal: a lone one matches nothing rather than every order.
    for (const keyword of ['%', '_']) {
      const literal = await order.orderConsole.adminList(asAdmin(adminId), listQuery({ keyword }));
      expect(literal.total).toBe(0);
    }
  });

  it('masks the buyer’s account phone in the list and shows it whole in the detail', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    await harness.ctx.db
      .update(users)
      .set({ phone: '13912345678' })
      .where(eq(users.id, placed.userId));

    const listed = await order.orderConsole.adminList(asAdmin(adminId), listQuery());
    expect(listed.items[0]!.user.phone).toBe('139****5678');
    const detail = await order.orderConsole.adminDetail(asAdmin(adminId), {
      id: String(placed.orderId),
    });
    expect(detail.user.phone).toBe('13912345678');
  });

  it('hides a deleted order unless the operator asks for the deleted ones', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    await order.cancel(as(placed.userId), { id: String(placed.orderId) }, {});
    await order.orderConsole.adminDelete(asAdmin(adminId), { id: String(placed.orderId) });

    expect((await order.orderConsole.adminList(asAdmin(adminId), listQuery())).total).toBe(0);
    expect(
      (await order.orderConsole.adminList(asAdmin(adminId), listQuery({ deleted: true }))).total,
    ).toBe(1);
  });
});

describe('one order', () => {
  it('shows the operator what the buyer never sees', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    await pay(placed);

    const detail = await order.orderConsole.adminDetail(asAdmin(adminId), {
      id: String(placed.orderId),
    });
    expect(detail.status).toBe('paid');
    expect(detail.transactionNo).toBe(`WX-${placed.orderId}`);
    expect(detail).toHaveProperty('costAmount');
    expect(detail.shipments).toEqual([]);
    expect(detail.refundIds).toEqual([]);
  });

  it('shows 成本 to whoever works or exports orders, not to a role that may only look', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    await harness.ctx.db
      .update(orders)
      .set({ costAmount: '30.00' })
      .where(eq(orders.id, placed.orderId));
    const holding = (permissions: string[]): Ctx =>
      harness.as({ kind: 'admin', id: adminId, permissions, isSuper: false });
    const read = orderPermissions['order:read'];
    const params = { id: String(placed.orderId) };

    const looking = await order.orderConsole.adminDetail(holding([read]), params);
    expect(looking.costAmount).toBeNull();
    const working = await order.orderConsole.adminDetail(
      holding([read, orderPermissions['order:write']]),
      params,
    );
    expect(working.costAmount).toBe('30.00');
    const exporting = await order.orderConsole.adminDetail(
      holding([read, orderPermissions['order:export']]),
      params,
    );
    expect(exporting.costAmount).toBe('30.00');
  });

  it('refuses an id that is not there', async () => {
    const adminId = await makeAdmin();
    await expect(
      order.orderConsole.adminDetail(asAdmin(adminId), { id: '999999' }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });

  it('reads the timeline back in order', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    await pay(placed);
    await order.orderConsole.adminRemark(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      { adminRemark: '客户要求周末送' },
    );

    const timeline = await order.orderConsole.adminTimeline(asAdmin(adminId), {
      id: String(placed.orderId),
    });
    expect(timeline.items.map((entry) => entry.changeType)).toContain('remark_updated');
    const remark = timeline.items.find((entry) => entry.changeType === 'remark_updated')!;
    expect(remark.operatorKind).toBe('admin');
    expect(remark.message).toBe('客户要求周末送');
  });
});

// ---------------------------------------------------------------------------
// 备注
// ---------------------------------------------------------------------------

describe('备注', () => {
  it('records the operator who wrote it', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    await pay(placed);

    await order.orderConsole.adminRemark(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      { adminRemark: '后台备注' },
    );
    expect((await orderRow(placed.orderId)).adminRemark).toBe('后台备注');

    const remarks = (await logsOf(placed.orderId)).filter(
      (log) => log.changeType === 'remark_updated',
    );
    expect(remarks).toMatchObject([{ operatorKind: 'admin', operatorAdminId: adminId }]);
  });

  it('refuses a shopper: only an operator acts through the console', async () => {
    const placed = await placeOrder();
    await pay(placed);
    const shopperId = await makeUser();

    await expect(
      order.orderConsole.adminRemark(
        as(shopperId),
        { id: String(placed.orderId) },
        { adminRemark: '不该写进去' },
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect((await orderRow(placed.orderId)).adminRemark).not.toBe('不该写进去');
  });
});

// ---------------------------------------------------------------------------
// 改价
// ---------------------------------------------------------------------------

describe('改价', () => {
  it('rewrites the order and every line, and the shares still sum back', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder({ quantity: 2 });

    const detail = await order.orderConsole.adminAdjustPrice(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      { operatorDiscount: '20.00', reason: '老客户' },
    );

    expect(detail.couponDiscount).toBe('20.00');
    expect(detail.payableAmount).toBe('100.00');

    const items = await harness.ctx.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, placed.orderId));
    expect(Money.sum(items.map((item) => Money.parse(item.discountAmount))).toString()).toBe(
      '20.00',
    );
    expect(Money.sum(items.map((item) => Money.parse(item.totalAmount))).toString()).toBe('100.00');

    const log = (await logsOf(placed.orderId)).find(
      (entry) => entry.changeType === 'price_adjusted',
    );
    expect(log?.message).toContain('老客户');
  });

  it('refuses a discount larger than the goods, and says what would have fitted', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    await expect(
      order.orderConsole.adminAdjustPrice(
        asAdmin(adminId),
        { id: String(placed.orderId) },
        { operatorDiscount: '600.00' },
      ),
    ).rejects.toMatchObject({ code: 'ORDER_PRICE_INVALID' });
    expect((await orderRow(placed.orderId)).payableAmount).toBe('60.00');
  });

  /** 改价 must never rewrite an order the buyer has already paid for. */
  it('refuses once the money has arrived', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    await pay(placed);

    await expect(
      order.orderConsole.adminAdjustPrice(
        asAdmin(adminId),
        { id: String(placed.orderId) },
        { operatorDiscount: '5.00' },
      ),
    ).rejects.toMatchObject({ code: 'ORDER_PRICE_NOT_ADJUSTABLE' });
    expect((await orderRow(placed.orderId)).payableAmount).toBe('60.00');
  });

  it('can set the freight at the same time', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    const detail = await order.orderConsole.adminAdjustPrice(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      { operatorDiscount: '0.00', freightAmount: '12.00' },
    );
    expect(detail.freightAmount).toBe('12.00');
    expect(detail.payableAmount).toBe('72.00');
  });

  /**
   * A buyer who is not told pays the amount they were shown, the gateway takes
   * the wrong total, and the order sits there.
   */
  it('tells the buyer, with both amounts, in the same transaction', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();

    await order.orderConsole.adminAdjustPrice(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      { operatorDiscount: '20.00' },
    );

    const [row] = await priceChangeEffects();
    expect(row).toMatchObject({ scope: 'notification', status: 'pending' });
    expect(row?.scopeId).toBe(`order_price_changed:order-price:${placed.orderId}:40.00`);
    expect(row?.payload).toMatchObject({
      event: 'order_price_changed',
      userId: placed.userId,
      data: { orderId: placed.orderId, oldAmount: '60.00', amount: '40.00' },
    });
  });

  it('tells nobody when the repricing itself was refused', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    await pay(placed);

    await expect(
      order.orderConsole.adminAdjustPrice(
        asAdmin(adminId),
        { id: String(placed.orderId) },
        { operatorDiscount: '5.00' },
      ),
    ).rejects.toMatchObject({ code: 'ORDER_PRICE_NOT_ADJUSTABLE' });
    expect(await priceChangeEffects()).toEqual([]);
  });

  /**
   * The subject carries the resulting amount rather than only the order id.
   * An order may legitimately be repriced more than once — each 改价 replaces
   * the last — and a per-order key would deduplicate every change after the
   * first into silence. A save that leaves the total where it was notifies once.
   */
  it('tells the buyer again when the price moves again, and not when it does not', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    const reprice = (operatorDiscount: string) =>
      order.orderConsole.adminAdjustPrice(
        asAdmin(adminId),
        { id: String(placed.orderId) },
        { operatorDiscount },
      );

    expect((await reprice('20.00')).payableAmount).toBe('40.00');
    // 0.00 takes the 改价 back: the buyer owes the checkout price again.
    const undone = await reprice('0.00');
    expect(undone.payableAmount).toBe('60.00');
    expect(undone.operatorDiscount).toBe('0.00');
    // Replaces, never adds: 10 after 20 is 10 off, not 30.
    const again = await reprice('10.00');
    expect(again.payableAmount).toBe('50.00');
    expect(again.operatorDiscount).toBe('10.00');
    // The same 改价 twice leaves the total, and the buyer, alone.
    expect((await reprice('10.00')).payableAmount).toBe('50.00');

    expect((await priceChangeEffects()).map((row) => row.scopeId).sort()).toEqual([
      `order_price_changed:order-price:${placed.orderId}:40.00`,
      `order_price_changed:order-price:${placed.orderId}:50.00`,
      `order_price_changed:order-price:${placed.orderId}:60.00`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 修改收货地址
// ---------------------------------------------------------------------------

describe('修改收货地址', () => {
  const address = {
    name: '李四',
    phone: '13900139000',
    province: '江苏省',
    city: '南京市',
    district: '鼓楼区',
    detail: '中山北路 1 号',
  };

  it('is allowed while nothing has gone out', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    await pay(placed);

    const detail = await order.orderConsole.adminUpdateAddress(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      address,
    );
    expect(detail.receiver).toMatchObject({ name: '李四', city: '南京市' });
    expect((await logsOf(placed.orderId)).some((log) => log.changeType === 'address_updated')).toBe(
      true,
    );
  });

  /** A parcel already in a van must keep the label it was printed with. */
  it('is refused once the order has been dispatched', async () => {
    const adminId = await makeAdmin();
    const company = await makeExpressCompany();
    const placed = await placeOrder();
    await pay(placed);
    await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      {
        deliveryMode: 'express',
        expressCompanyId: String(company),
        trackingNo: 'SF1',
        lines: [],
      },
    );

    await expect(
      order.orderConsole.adminUpdateAddress(
        asAdmin(adminId),
        { id: String(placed.orderId) },
        address,
      ),
    ).rejects.toMatchObject({ code: 'ORDER_ADDRESS_NOT_EDITABLE' });
    expect((await orderRow(placed.orderId)).receiverName).toBe('张三');
  });
});

// ---------------------------------------------------------------------------
// 删除订单
// ---------------------------------------------------------------------------

describe('删除订单', () => {
  it('refuses an order that is still in flight', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    await pay(placed);

    await expect(
      order.orderConsole.adminDelete(asAdmin(adminId), { id: String(placed.orderId) }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_DELETABLE' });
    expect((await orderRow(placed.orderId)).deletedAt).toBeNull();
  });

  it('files away a cancelled one and refuses to do it twice', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    await order.cancel(as(placed.userId), { id: String(placed.orderId) }, {});

    expect(
      await order.orderConsole.adminDelete(asAdmin(adminId), { id: String(placed.orderId) }),
    ).toEqual({ deleted: true });
    expect((await orderRow(placed.orderId)).deletedAt).not.toBeNull();

    await expect(
      order.orderConsole.adminDelete(asAdmin(adminId), { id: String(placed.orderId) }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_DELETABLE' });
  });

  it('skips what it cannot delete in a batch rather than failing the lot', async () => {
    const adminId = await makeAdmin();
    const finished = await placeOrder();
    await order.cancel(as(finished.userId), { id: String(finished.orderId) }, {});
    const live = await placeOrder();
    await pay(live);

    const result = await order.orderConsole.adminDeleteMany(asAdmin(adminId), {
      ids: [String(finished.orderId), String(live.orderId)],
    });
    expect(result).toEqual({ deleted: 1, skippedIds: [String(live.orderId)] });
    expect((await orderRow(live.orderId)).deletedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 退款中
// ---------------------------------------------------------------------------

/** A 已完成 order, as confirm-receipt and the completion sweep would leave it. */
async function complete(placed: Placed): Promise<void> {
  await pay(placed);
  await harness.ctx.db
    .update(orders)
    .set({ status: 'completed', fulfillmentStatus: 'fulfilled' })
    .where(eq(orders.id, placed.orderId));
}

async function fileRefund(
  placed: Placed,
  status: 'applied' | 'failed' | 'cancelled',
  { refunded = '0.00' }: { refunded?: string } = {},
): Promise<void> {
  sequence += 1;
  await harness.ctx.db.insert(refunds).values({
    refundNo: `RF-${sequence}`,
    outRefundNo: `ORF-${sequence}`,
    orderId: placed.orderId,
    userId: placed.userId,
    kind: 'refund_only',
    status,
    quantity: 1,
    amount: '10.00',
    cancelledAt: status === 'cancelled' ? new Date() : null,
    failedAt: status === 'failed' ? new Date() : null,
  });
  if (refunded !== '0.00') {
    await harness.ctx.db
      .update(orders)
      .set({ refundStatus: 'partially_refunded', refundedAmount: refunded })
      .where(eq(orders.id, placed.orderId));
  }
}

describe('ORDER-014 — 退款中 means an after-sales request still open', () => {
  it('lists and counts an open request, and not an order whose request closed after a partial refund', async () => {
    const adminId = await makeAdmin();
    const open = await placeOrder();
    await complete(open);
    await fileRefund(open, 'applied');
    // Money went back once and the request is closed: `partially_refunded` for good.
    const settled = await placeOrder();
    await complete(settled);
    await fileRefund(settled, 'cancelled', { refunded: '10.00' });
    // A failed refund still holds its lines until the merchant retries or closes it.
    const failed = await placeOrder();
    await complete(failed);
    await fileRefund(failed, 'failed');

    const listed = await order.orderConsole.adminList(
      asAdmin(adminId),
      listQuery({ refunding: true }),
    );
    expect(listed.items.map((row) => row.id).sort()).toEqual(
      [String(open.orderId), String(failed.orderId)].sort(),
    );

    const stats = await order.orderConsole.adminStatistics(asAdmin(adminId), {});
    expect(stats.refunding).toBe(2);

    // The shopper's 退款/售后 badge and tab say the same.
    expect((await order.counts(as(open.userId))).refunding).toBe(1);
    expect((await order.counts(as(settled.userId))).refunding).toBe(0);
    const tab = await order.list(as(settled.userId), {
      tab: 'refunding',
      page: 1,
      pageSize: 20,
      sortOrder: 'desc',
    });
    expect(tab.total).toBe(0);

    // The shopper's own rows carry it, so the card says 售后中 after a partial
    // refund too, and stops once the request closed.
    const mine = async (userId: number) =>
      (await order.list(as(userId), { tab: 'all', page: 1, pageSize: 20, sortOrder: 'desc' }))
        .items[0]!.hasOpenRefund;
    expect(await mine(open.userId)).toBe(true);
    expect(await mine(failed.userId)).toBe(true);
    expect(await mine(settled.userId)).toBe(false);
    expect((await order.detail(as(open.userId), { id: String(open.orderId) })).hasOpenRefund).toBe(
      true,
    );
    expect(
      (await order.detail(as(settled.userId), { id: String(settled.orderId) })).hasOpenRefund,
    ).toBe(false);
  });

  it('neither 删除 nor the shopper’s 删除订单 files away an order whose request is still open', async () => {
    const adminId = await makeAdmin();
    const open = await placeOrder();
    await complete(open);
    await fileRefund(open, 'applied');

    await expect(
      order.orderConsole.adminDelete(asAdmin(adminId), { id: String(open.orderId) }),
    ).rejects.toMatchObject({
      code: 'ORDER_NOT_DELETABLE',
      message: '订单还有售后在处理，处理完后才能删除',
    });
    expect(
      await order.orderConsole.adminDeleteMany(asAdmin(adminId), { ids: [String(open.orderId)] }),
    ).toEqual({ deleted: 0, skippedIds: [String(open.orderId)] });
    await expect(order.hide(as(open.userId), { id: String(open.orderId) })).rejects.toMatchObject({
      code: 'ORDER_NOT_DELETABLE',
    });
    const row = await orderRow(open.orderId);
    expect(row.deletedAt).toBeNull();
    expect(row.hiddenByUserAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

describe('the work queue and the totals', () => {
  it('counts what an operator has to do right now', async () => {
    const adminId = await makeAdmin();
    const company = await makeExpressCompany();

    const waiting = await placeOrder();
    await pay(waiting);

    const shipped = await placeOrder();
    await pay(shipped);
    await order.adminShip(
      asAdmin(adminId),
      { id: String(shipped.orderId) },
      {
        deliveryMode: 'express',
        expressCompanyId: String(company),
        trackingNo: 'SF2',
        lines: [],
      },
    );

    const invoiced = await placeOrder();
    await pay(invoiced);
    await order.orderInvoices.request(
      as(invoiced.userId),
      { id: String(invoiced.orderId) },
      { headerType: 'personal', invoiceType: 'plain', name: '张三' },
    );

    const stats = await order.orderConsole.adminStatistics(asAdmin(adminId), {});
    expect(stats.pendingShipment).toBe(2); // the waiting one and the invoiced one
    expect(stats.pendingReceipt).toBe(1);
    expect(stats.pendingInvoice).toBe(1);
    expect(stats.refunding).toBe(0);
  });

  it('does not count 待开票 for an order an operator deleted', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    await complete(placed);
    await order.orderInvoices.request(
      as(placed.userId),
      { id: String(placed.orderId) },
      { headerType: 'personal', invoiceType: 'plain', name: '张三' },
    );
    expect((await order.orderConsole.adminStatistics(asAdmin(adminId), {})).pendingInvoice).toBe(1);

    await order.orderConsole.adminDelete(asAdmin(adminId), { id: String(placed.orderId) });
    expect((await order.orderConsole.adminStatistics(asAdmin(adminId), {})).pendingInvoice).toBe(0);
  });

  it('pads an unpadded numeric sum into money on the wire', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    await pay(placed, '60.50');

    // `orders.created_at` is stamped by the database's `now()`, not by
    // `ctx.clock`, so the window has to be named explicitly here — in
    // production the two are the same clock, in a test with a fixed one they
    // are not.
    const stats = await order.orderConsole.adminStatistics(asAdmin(adminId), {
      from: '2020-01-01T00:00:00.000Z',
      to: '2099-01-01T00:00:00.000Z',
    });
    expect(stats.orderCount).toBe(1);
    expect(stats.paidOrderCount).toBe(1);
    expect(stats.paidAmount).toBe('60.50');
    expect(stats.refundedAmount).toBe('0.00');
  });

  it('近 30 天实付 counts what was paid and refunded in the window, as 交易统计 does', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    // Paid at the test clock, 08:00 on 1 June in Shanghai; `created_at` is the
    // database's own now(), so only a `paid_at` population finds it.
    await pay(placed, '60.50');
    sequence += 1;
    await harness.ctx.db.insert(refunds).values({
      refundNo: `RF-${sequence}`,
      outRefundNo: `ORF-${sequence}`,
      orderId: placed.orderId,
      userId: placed.userId,
      kind: 'refund_only',
      status: 'succeeded',
      quantity: 1,
      amount: '10.00',
      refundedAmount: '10.00',
      succeededAt: new Date(NOW),
    });

    const stats = await order.orderConsole.adminStatistics(asAdmin(adminId), {});
    expect(stats.range.to).toBe('2026-06-01T16:00:00.000Z');
    expect(stats.paidOrderCount).toBe(1);
    expect(stats.paidAmount).toBe('60.50');
    expect(stats.refundedAmount).toBe('10.00');
  });

  it('counts nothing at all without dividing by zero', async () => {
    const adminId = await makeAdmin();
    const stats = await order.orderConsole.adminStatistics(asAdmin(adminId), {});
    expect(stats).toMatchObject({ orderCount: 0, paidAmount: '0.00', refundedAmount: '0.00' });
  });
});

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

describe('导出', () => {
  it('writes a CSV with the header and one row per order', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    await pay(placed);
    const row = await orderRow(placed.orderId);

    const result = await order.orderConsole.adminExport(asAdmin(adminId), {
      kindOfExport: 'orders',
      deleted: false,
    });
    expect(result.contentType).toBe('text/csv');
    expect(result.filename).toBe('订单-2026-06-01.csv');
    expect(result.rowCount).toBe(1);
    expect(result.truncated).toBe(false);

    const lines = result.content.trimEnd().split('\n');
    expect(lines[0]).toContain('订单号');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(row.orderNo);
    // The enum comes out as the label an operator reads, not as `paid`.
    expect(lines[1]).toContain('待发货');
  });

  it('prints times and dates the file on the Shanghai day', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    await pay(placed); // paid at 2026-06-01T00:00Z, 08:00 in Shanghai
    // 00:30 on 2 June in Shanghai, still 1 June in UTC.
    harness.clock.set('2026-06-01T16:30:00.000Z');

    const result = await order.orderConsole.adminExport(asAdmin(adminId), {
      kindOfExport: 'orders',
      deleted: false,
    });
    expect(result.filename).toBe('订单-2026-06-02.csv');
    const [, line] = result.content.trimEnd().split('\n');
    expect(line).toContain('2026-06-01 08:00:00');
    expect(line).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  });

  /** CSV injection, end to end: a receiver name typed by a buyer. */
  it('defuses a formula a buyer typed into their own address', async () => {
    const adminId = await makeAdmin();
    const placed = await placeOrder();
    await harness.ctx.db
      .update(orders)
      .set({ receiverName: "=cmd|'/c calc'!A1" })
      .where(eq(orders.id, placed.orderId));

    const result = await order.orderConsole.adminExport(asAdmin(adminId), {
      kindOfExport: 'orders',
      deleted: false,
    });
    expect(result.content).toContain("'=cmd|'/c calc'!A1");
    expect(result.content).not.toMatch(/,=cmd/);
  });

  it('exports the shipments as their own sheet', async () => {
    const adminId = await makeAdmin();
    const company = await makeExpressCompany();
    const placed = await placeOrder({ quantity: 2 });
    await pay(placed);
    await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      {
        deliveryMode: 'express',
        expressCompanyId: String(company),
        trackingNo: 'SF-EXPORT',
        lines: [],
      },
    );

    const result = await order.orderConsole.adminExport(asAdmin(adminId), {
      kindOfExport: 'shipments',
      deleted: false,
    });
    expect(result.filename).toBe('发货单-2026-06-01.csv');
    // 发货时间 as staff read it: Shanghai wall time, not an ISO string in UTC.
    expect(result.content).toContain('2026-06-01 08:00:00');
    expect(result.content).not.toContain('T00:00:00');
    expect(result.rowCount).toBe(1);
    expect(result.content).toContain('SF-EXPORT');
    expect(result.content).toContain('发货单号');
  });

  it('exports what the filter selected, not the whole shop', async () => {
    const adminId = await makeAdmin();
    const paid = await placeOrder();
    await pay(paid);
    await placeOrder(); // left pending

    const result = await order.orderConsole.adminExport(asAdmin(adminId), {
      kindOfExport: 'orders',
      deleted: false,
      status: ['paid'],
    });
    expect(result.rowCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.content).toContain((await orderRow(paid.orderId)).orderNo);
  });
});
