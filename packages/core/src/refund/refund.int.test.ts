import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { admins } from '@shop/db/schema/auth';
import { products, productSkus } from '@shop/db/schema/catalog';
import { orderItems, orders, type OrderItemSnapshot } from '@shop/db/schema/order';
import { couponTemplates, userCoupons } from '@shop/db/schema/coupon';
import { capitalFlows } from '@shop/db/schema/payment';
import { refunds } from '@shop/db/schema/refund';
import { attachments } from '@shop/db/schema/storage';
import { users } from '@shop/db/schema/user';
import {
  createTestCtx,
  flushTestRedis,
  forkTestCtx,
  startFakeWechatGateway,
  type FakeWechatGateway,
  type TestCtx,
} from '@shop/testing';
import { effects as effectsTable } from '@shop/db/schema/system';
import { resetEffectHandlers } from '../effects';
import type { Actor, Ctx } from '../kernel/context';
import { registerNotificationDomain } from '../notification';
import { registerStockPort, resetOrderPorts, type StockLine } from '../order/ports';
import { installFulfilmentHooks } from '../order';
import { handleTransactionNotify, paymentConfig, startPayment } from '../payment';
import { wechatConfig } from '../wechat';
import { refundConfig } from './refund.config';
import * as repo from './refund.repo';
import * as admin from './refund.admin';
import * as service from './refund.service';

/**
 * After-sales, one caller at a time.
 *
 * The races are in `refund.concurrency.int.test.ts`. What is left is the
 * arithmetic of *sending* the money: which payment a refund is frozen against,
 * what happens when there is no such payment, and what a retry is allowed to
 * change. None of it is allowed to move money twice.
 */

let harness: TestCtx;
let gateway: FakeWechatGateway;

const NOW = '2026-06-01T00:00:00.000Z';

/** `StockPort.release` calls the settlement made, and an optional sabotage. */
let releases: Array<{ orderId: number; lines: StockLine[] }> = [];
let releaseFails = false;

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
  gateway = await startFakeWechatGateway({ now: () => harness.clock.now().getTime() });
}, 180_000);

afterAll(async () => {
  await gateway?.close();
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await flushTestRedis(harness.redis);
  harness.clock.set(NOW);
  resetEffectHandlers();
  resetOrderPorts();
  installFulfilmentHooks();
  // `resetOrderPorts` clears every hook registry. Without this `notify` drops
  // the event — which is the right behaviour for an unregistered code, and
  // would also let the assertions below pass while proving nothing.
  registerNotificationDomain();
  releases = [];
  releaseFails = false;
  registerStockPort({
    async reserve() {
      return [];
    },
    async commit() {},
    async release(_tx, orderId, lines) {
      if (releaseFails) throw new Error('库存回退失败');
      releases.push({ orderId, lines: [...lines] });
    },
  });
  gateway.transactions.clear();
  gateway.refunds.clear();
  gateway.calls.length = 0;
  gateway.behaviour.refundBalanceFen = null;
  gateway.behaviour.refundStatus = 'PROCESSING';
  gateway.behaviour.signResponsesWithWrongKey = false;
  gateway.behaviour.failNext = null;
  gateway.behaviour.dropNext = false;
  await configure();
});

afterEach(() => {
  resetEffectHandlers();
  resetOrderPorts();
  installFulfilmentHooks();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });
const adminActor = (id: number): Actor => ({ kind: 'admin', id, permissions: [], isSuper: true });

function racer(actor?: Actor): Ctx {
  return forkTestCtx(harness, actor === undefined ? {} : { actor });
}

async function configure(): Promise<void> {
  await harness.ctx.config.set(paymentConfig, {
    mchId: gateway.keys.mchId,
    apiV3Key: gateway.keys.apiV3Key,
    certSerial: gateway.keys.merchantSerial,
    merchantPrivateKey: gateway.keys.merchantPrivateKeyPem,
    platformPublicKeyId: gateway.keys.platformSerial,
    platformPublicKey: gateway.keys.platformPublicKeyPem,
    notifyBaseUrl: 'https://shop.example.test',
    apiBaseUrl: gateway.url,
    payExpiryMinutes: 30,
  });
  await harness.ctx.config.set(wechatConfig, {
    miniAppId: gateway.keys.appId,
    oaAppId: gateway.keys.appId,
  });
}

let sequence = 0;

const snapshot = (index: number): OrderItemSnapshot => ({
  productName: `测试商品 ${index + 1}`,
  productImageUrl: 'https://cdn.example.test/p.jpg',
  productKind: 'physical',
  skuCode: `SKU-${index + 1}`,
  specText: '默认',
  specValues: {},
});

interface PaidOrder {
  orderId: number;
  userId: number;
  adminId: number;
  itemIds: number[];
  payable: string;
  outTradeNo: string | null;
}

/**
 * An order that reached `paid`.
 *
 * `throughWechat: false` is an order whose money came in some other way (余额,
 * 线下, an imported 支付宝 order): there is no `payment_attempts` row to refund
 * against (REFUND-001).
 */
async function paidOrder(
  options: { throughWechat?: boolean; payable?: string } = {},
): Promise<PaidOrder> {
  sequence += 1;
  const n = sequence;
  const db = harness.ctx.db;
  const payable = options.payable ?? '100.00';
  const throughWechat = options.throughWechat ?? true;

  const [user] = await db
    .insert(users)
    .values({ account: `rint-user-${n}` })
    .returning({ id: users.id });
  const [operator] = await db
    .insert(admins)
    .values({
      account: `rint-admin-${n}`,
      passwordHash: 'x'.repeat(60),
      name: `运营${n}`,
      isSuper: true,
    })
    .returning({ id: admins.id });
  const [product] = await db
    .insert(products)
    .values({
      name: `测试商品 ${n}`,
      imageUrl: 'https://cdn.example.test/p.jpg',
      status: 'on_shelf',
      freightMode: 'free',
      price: '50.00',
    })
    .returning({ id: products.id });
  const [sku] = await db
    .insert(productSkus)
    .values({ productId: product!.id, skuCode: `RSKU${n}`, price: '50.00', stock: 100 })
    .returning({ id: productSkus.id });
  const [order] = await db
    .insert(orders)
    .values({
      orderNo: `RO${String(n).padStart(10, '0')}`,
      userId: user!.id,
      platform: 'wechat_mini',
      status: 'pending_payment',
      totalQuantity: 2,
      itemsAmount: payable,
      payableAmount: payable,
      payExpiresAt: new Date(Date.parse(NOW) + 30 * 60_000),
      receiverName: '张三',
      receiverPhone: '13800000000',
      receiverProvince: '广东省',
      receiverCity: '深圳市',
      receiverDetail: '某路 1 号',
    })
    .returning({ id: orders.id });
  const [item] = await db
    .insert(orderItems)
    .values({
      orderId: order!.id,
      productId: product!.id,
      skuId: sku!.id,
      itemKey: 'L1',
      quantity: 2,
      unitPrice: '50.00',
      totalAmount: payable,
      snapshot: snapshot(0),
    })
    .returning({ id: orderItems.id });

  const base = {
    orderId: order!.id,
    userId: user!.id,
    adminId: operator!.id,
    itemIds: [item!.id],
    payable,
  };

  if (!throughWechat) {
    // Paid without a gateway attempt, the way a migrated order looks.
    await db
      .update(orders)
      .set({
        status: 'paid',
        paidAt: harness.clock.now(),
        paidAmount: payable,
        transactionNo: null,
      })
      .where(eq(orders.id, order!.id));
    return { ...base, outTradeNo: null };
  }

  const intent = await startPayment(racer(userActor(user!.id)), {
    orderId: order!.id,
    channel: 'wechat_mini',
    openid: 'oFakeOpenid',
  });
  gateway.markPaid(intent.outTradeNo);
  const ack = await handleTransactionNotify(
    racer(),
    gateway.signTransactionNotification({ outTradeNo: intent.outTradeNo }),
  );
  expect(ack.status).toBe(200);

  return { ...base, outTradeNo: intent.outTradeNo };
}

function applyBody(order: PaidOrder, quantity: number): Parameters<typeof service.apply>[1] {
  return {
    orderId: String(order.orderId),
    kind: 'refund_only',
    lines: [{ orderItemId: String(order.itemIds[0]!), quantity }],
    reason: '不想要了',
    images: [],
    includeFreight: false,
  };
}

/** Applies and approves one refund, leaving it ready to send. */
async function approvedRefund(order: PaidOrder, quantity = 1): Promise<number> {
  const applied = await service.apply(racer(userActor(order.userId)), applyBody(order, quantity));
  const id = Number(applied.id);
  await admin.adminApprove(racer(adminActor(order.adminId)), { id: String(id) });
  return id;
}

const refundRow = (id: number) =>
  harness.ctx.db
    .select()
    .from(refunds)
    .where(eq(refunds.id, id))
    .then((rows) => rows[0]!);

const orderRow = (id: number) =>
  harness.ctx.db
    .select()
    .from(orders)
    .where(eq(orders.id, id))
    .then((rows) => rows[0]!);

const flowRows = (kind: 'order_payment' | 'order_refund') =>
  harness.ctx.db.select().from(capitalFlows).where(eq(capitalFlows.kind, kind));

/** Every notification recorded so far, by key. `notify` records; nothing sends. */
async function notificationEffects() {
  const rows = await harness.ctx.db
    .select()
    .from(effectsTable)
    .where(eq(effectsTable.scope, 'notification'));
  return rows.sort((a, b) => a.scopeId.localeCompare(b.scopeId));
}

const notificationKeys = async () => (await notificationEffects()).map((row) => row.scopeId);

/** Just the after-sales ones: `paidOrder()` records the order's own on the way in. */
const refundNotificationKeys = async () =>
  (await notificationKeys()).filter((key) => key.includes(':refund:'));

const notificationFor = async (key: string) =>
  (await notificationEffects()).find((row) => row.scopeId === key);

// ---------------------------------------------------------------------------
// the four notifications the after-sales flow owes
// ---------------------------------------------------------------------------

describe('after-sales notifications', () => {
  it('records the buyer’s receipt and the 待处理 badge in the apply transaction', async () => {
    const order = await paidOrder();
    const applied = await service.apply(racer(userActor(order.userId)), applyBody(order, 1));
    const id = Number(applied.id);

    expect(await refundNotificationKeys()).toEqual([
      `admin_refund_applied:refund:${id}`,
      `refund_applied:refund:${id}`,
    ]);

    const orderNo = (await orderRow(order.orderId)).orderNo;
    const userRow = await notificationFor(`refund_applied:refund:${id}`);
    const adminRow = await notificationFor(`admin_refund_applied:refund:${id}`);
    expect(userRow).toMatchObject({ status: 'pending' });
    expect(userRow?.payload).toMatchObject({
      event: 'refund_applied',
      userId: order.userId,
      // The order number the shopper knows, not the internal order id.
      data: { refundNo: applied.refundNo, orderNo, amount: '50.00' },
    });
    // The admin copy has no recipient: fan-out resolves whoever holds
    // `refund:request:read`, and it carries the reason the buyer gave.
    expect(adminRow?.payload).toMatchObject({
      event: 'admin_refund_applied',
      data: { amount: '50.00', reason: '不想要了' },
    });
    expect(adminRow?.payload).not.toHaveProperty('userId');
  });

  it('records nothing when the request loses the open-line race', async () => {
    const order = await paidOrder();
    await service.apply(racer(userActor(order.userId)), applyBody(order, 1));
    const before = await notificationKeys();

    // A second request for a line somebody already has open: `refund_items_open_uq`
    // decides it, the whole transaction goes, and no 退款申请已提交 is left over.
    await expect(
      service.apply(racer(userActor(order.userId)), applyBody(order, 1)),
    ).rejects.toMatchObject({ code: 'REFUND_ALREADY_OPEN' });
    expect(await notificationKeys()).toEqual(before);
  });

  it('two partial refunds of one order are two notifications, not one', async () => {
    const order = await paidOrder();
    const first = Number(
      (await service.apply(racer(userActor(order.userId)), applyBody(order, 1))).id,
    );
    await admin.adminReject(racer(adminActor(order.adminId)), {
      id: String(first),
      rejectReason: '超出售后期',
    });
    const second = Number(
      (await service.apply(racer(userActor(order.userId)), applyBody(order, 1))).id,
    );

    expect(await notificationKeys()).toContain(`refund_applied:refund:${first}`);
    expect(await notificationKeys()).toContain(`refund_applied:refund:${second}`);
  });

  it('tells the buyer when the review approves, with the order number they know', async () => {
    const order = await paidOrder();
    const id = await approvedRefund(order, 1);

    const approved = await notificationFor(`refund_approved:refund:${id}`);
    expect(approved).toMatchObject({ scope: 'notification', status: 'pending' });
    expect(approved?.payload).toMatchObject({
      event: 'refund_approved',
      userId: order.userId,
      data: { refundId: id, amount: '50.00', refundNote: '的 ¥50.00 将原路退回' },
    });
    expect((approved?.payload as { data: { orderNo: string } }).data.orderNo).toMatch(/^RO\d+$/);
  });

  it('tells the buyer why when the review rejects', async () => {
    const order = await paidOrder();
    const applied = await service.apply(racer(userActor(order.userId)), applyBody(order, 1));
    const id = Number(applied.id);

    await admin.adminReject(racer(adminActor(order.adminId)), {
      id: String(id),
      rejectReason: '已超过 7 天无理由期限',
    });

    const rejected = await notificationFor(`refund_rejected:refund:${id}`);
    expect(rejected?.payload).toMatchObject({
      event: 'refund_rejected',
      userId: order.userId,
      data: { refundNo: applied.refundNo, reason: '已超过 7 天无理由期限' },
    });
  });

  it('tells nobody when the review itself was refused', async () => {
    const order = await paidOrder();
    const id = await approvedRefund(order, 1);
    const before = await notificationKeys();

    // Already approved: `transitionRefund` affects no rows and the whole
    // review transaction goes, notification included.
    await expect(
      admin.adminApprove(racer(adminActor(order.adminId)), { id: String(id) }),
    ).rejects.toMatchObject({ code: 'REFUND_NOT_ACTIONABLE' });
    expect(await notificationKeys()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// the return address is frozen at the approval
// ---------------------------------------------------------------------------

describe('the return address a buyer is shown', () => {
  const CONFIGURED = {
    returnName: '售后部',
    returnPhone: '13800000000',
    returnAddress: '浙江省杭州市西湖区文一西路 1 号',
  };
  const frozen = {
    name: CONFIGURED.returnName,
    phone: CONFIGURED.returnPhone,
    address: CONFIGURED.returnAddress,
  };

  async function returnRequest(order: PaidOrder): Promise<number> {
    const applied = await service.apply(racer(userActor(order.userId)), {
      ...applyBody(order, 1),
      kind: 'return_and_refund',
    });
    return Number(applied.id);
  }

  it('is written once, at the approval, and then read from the row', async () => {
    await harness.ctx.config.set(refundConfig, CONFIGURED);
    const order = await paidOrder();
    const id = await returnRequest(order);

    const approved = await admin.adminApprove(racer(adminActor(order.adminId)), { id: String(id) });
    expect(approved.returnAddress).toEqual(frozen);
    expect((await refundRow(id)).returnAddress).toEqual(frozen);
  });

  it('tells the buyer to send the goods back, not that the money is on its way', async () => {
    await harness.ctx.config.set(refundConfig, CONFIGURED);
    const order = await paidOrder();
    const id = await returnRequest(order);

    await admin.adminApprove(racer(adminActor(order.adminId)), { id: String(id) });
    const approved = await notificationFor(`refund_approved:refund:${id}`);
    expect(approved?.payload).toMatchObject({
      event: 'refund_approved',
      data: { refundId: id, refundNote: '的商品请寄回，地址见售后详情' },
    });
  });

  it('does not change when the shop edits 售后设置 afterwards', async () => {
    await harness.ctx.config.set(refundConfig, CONFIGURED);
    const order = await paidOrder();
    const id = await returnRequest(order);
    await admin.adminApprove(racer(adminActor(order.adminId)), { id: String(id) });

    // The shop moves warehouse. The parcel already in the post does not.
    await harness.ctx.config.set(refundConfig, {
      returnName: '新仓库',
      returnPhone: '13900000000',
      returnAddress: '江苏省南京市雨花台区 2 号',
    });

    const seen = await service.myDetail(racer(userActor(order.userId)), { id: String(id) });
    expect(seen.returnAddress).toEqual(frozen);
  });

  it('prefers the address the operator typed over the configured one', async () => {
    await harness.ctx.config.set(refundConfig, CONFIGURED);
    const order = await paidOrder();
    const id = await returnRequest(order);

    const typed = { name: '王五', phone: '13700000000', address: '上海市浦东新区 3 号' };
    const approved = await admin.adminApprove(racer(adminActor(order.adminId)), {
      id: String(id),
      returnAddress: typed,
    });
    expect(approved.returnAddress).toEqual(typed);
    // …and the timeline records where the goods were sent, on its own.
    expect(approved.logs.some((log) => (log.message ?? '').includes(typed.address))).toBe(true);
  });

  it('refuses the approval when the shop has configured none and the operator typed none', async () => {
    // Half an address is no address: the phone is missing here.
    await harness.ctx.config.set(refundConfig, { ...CONFIGURED, returnPhone: '' });
    const order = await paidOrder();
    const id = await returnRequest(order);

    await expect(
      admin.adminApprove(racer(adminActor(order.adminId)), { id: String(id) }),
    ).rejects.toMatchObject({ code: 'REFUND_RETURN_ADDRESS_MISSING' });
    const row = await refundRow(id);
    expect(row.status).toBe('applied');
    expect(row.returnAddress).toBeNull();

    // The operator can still approve it by typing where the goods go.
    const typed = { name: '王五', phone: '13700000000', address: '上海市浦东新区 3 号' };
    const approved = await admin.adminApprove(racer(adminActor(order.adminId)), {
      id: String(id),
      returnAddress: typed,
    });
    expect(approved.returnAddress).toEqual(typed);
  });

  it('never shows one on a refund that needs no parcel', async () => {
    await harness.ctx.config.set(refundConfig, CONFIGURED);
    const order = await paidOrder();
    const id = await approvedRefund(order, 1);
    expect((await refundRow(id)).returnAddress).toBeNull();
    const seen = await service.myDetail(racer(userActor(order.userId)), { id: String(id) });
    expect(seen.returnAddress).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the ordinary refund
// ---------------------------------------------------------------------------

describe('a refund that goes the way it should', () => {
  it('computes the money from the lines, sends it, and books it when WeChat confirms', async () => {
    const order = await paidOrder();
    const id = await approvedRefund(order, 1);

    // The buyer asked for one of two units and named no amount at all; the
    // service is the only thing that decides what a line is worth.
    expect((await refundRow(id)).amount).toBe('50.00');

    gateway.behaviour.refundStatus = 'SUCCESS';
    expect(await service.executeRefund(racer(), id)).toEqual({
      status: 'succeeded',
      message: '退款成功',
    });

    const row = await refundRow(id);
    expect(row.status).toBe('succeeded');
    expect(row.succeededAt).not.toBeNull();

    const flows = await flowRows('order_refund');
    expect(flows).toHaveLength(1);
    expect(flows[0]!.direction).toBe('out');
    expect(flows[0]!.amount).toBe('50.00');

    const after = await orderRow(order.orderId);
    expect(after.refundedAmount).toBe('50.00');
    expect(after.refundStatus).toBe('partially_refunded');
    // Unshipped units go back to stock, once.
    expect(releases).toHaveLength(1);
    expect(releases[0]!.lines[0]!.quantity).toBe(1);

    expect(gateway.refunds.size).toBe(1);
  });

  it('only offers what is actually refundable', async () => {
    const order = await paidOrder();
    const items = await service.applicableItems(racer(userActor(order.userId)), {
      orderId: String(order.orderId),
    });
    expect(items.items).toHaveLength(1);
    expect(items.items[0]!.refundableQuantity).toBe(2);
    expect(items.items[0]!.blockedReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// REFUND-014 — evidence photos come from our own storage
// ---------------------------------------------------------------------------

describe('REFUND-014 — evidence photos come from our own storage', () => {
  const STORED = '/uploads/refund/2026/06/01/refund-014.png';

  async function storeImage(url: string): Promise<void> {
    await harness.ctx.db.insert(attachments).values({
      storageKey: url.replace(/^\/uploads\//, ''),
      driver: 'local',
      url,
      name: 'evidence.png',
      kind: 'image',
      mime: 'image/png',
      size: 26,
      sha256: 'd'.repeat(64),
    });
  }

  it('takes a photo our uploads stored', async () => {
    await storeImage(STORED);
    const order = await paidOrder();
    const applied = await service.apply(racer(userActor(order.userId)), {
      ...applyBody(order, 1),
      images: [STORED],
    });
    expect((await refundRow(Number(applied.id))).images).toEqual([STORED]);
  });

  it('refuses a link to somebody else’s server, and opens no request', async () => {
    const order = await paidOrder();
    for (const url of [
      'https://tracker.example.net/pixel.png',
      // Our path shape, but nothing we stored.
      '/uploads/refund/2026/06/01/never-uploaded.png',
    ]) {
      await expect(
        service.apply(racer(userActor(order.userId)), { ...applyBody(order, 1), images: [url] }),
      ).rejects.toMatchObject({ code: 'REFUND_IMAGE_NOT_ALLOWED' });
    }
    expect(await harness.ctx.db.select().from(refunds)).toHaveLength(0);
    expect(await refundNotificationKeys()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// REFUND-001 — an order with no original payment to refund
// ---------------------------------------------------------------------------

describe('REFUND-001 — there is no original channel to send it back through', () => {
  /**
   * The rule is structural rather than a list of pay types: a refund is frozen
   * against the `payment_attempts` row that collected the money, so an order
   * that has no such row cannot be refunded through the gateway at all,
   * whatever it was once paid with.
   */
  it('refuses to send, and says so, rather than inventing a transaction', async () => {
    const order = await paidOrder({ throughWechat: false });
    const id = await approvedRefund(order, 1);

    await expect(service.executeRefund(racer(), id)).rejects.toMatchObject({
      code: 'REFUND_NO_ORIGINAL_PAYMENT',
    });

    expect(gateway.refunds.size).toBe(0);
    expect(await flowRows('order_refund')).toEqual([]);
    // The request survives for an operator to settle by hand; nothing pretends
    // the money went back.
    const row = await refundRow(id);
    expect(row.succeededAt).toBeNull();
    expect(row.status).not.toBe('succeeded');
  });
});

// ---------------------------------------------------------------------------
// REFUND-004 — the restock fails
// ---------------------------------------------------------------------------

describe('REFUND-004 — a restock that fails never loses the money', () => {
  /**
   * Restoring the stock before talking to the gateway is not available — the
   * money moves at WeChat, which is outside any transaction — so the guarantee
   * is the other way round: the settlement (the ledger row, the order roll-up
   * and the restock) is one transaction, and if the restock throws, *none* of
   * it is written. The refund stays unsettled and the same `out_refund_no`
   * settles it later, so the money is neither lost nor sent twice.
   */
  it('rolls the settlement back and settles it once the restock works again', async () => {
    const order = await paidOrder();
    const id = await approvedRefund(order, 1);
    gateway.behaviour.refundStatus = 'SUCCESS';
    releaseFails = true;

    const result = await service.executeRefund(racer(), id);
    // The gateway took it; our side could not finish writing it down.
    expect(result.status).toBe('unknown');
    expect(gateway.refunds.size).toBe(1);

    const stuck = await refundRow(id);
    expect(stuck.status).toBe('unknown');
    expect(stuck.succeededAt).toBeNull();
    expect(await flowRows('order_refund')).toEqual([]);
    expect((await orderRow(order.orderId)).refundedAmount).toBe('0.00');
    expect(releases).toEqual([]);

    // The sweep asks about the frozen number rather than sending anything new.
    releaseFails = false;
    expect(await service.reconcileRefund(racer(), id)).toMatchObject({ status: 'succeeded' });

    expect(gateway.refunds.size).toBe(1);
    expect((await refundRow(id)).status).toBe('succeeded');
    expect(await flowRows('order_refund')).toHaveLength(1);
    expect((await orderRow(order.orderId)).refundedAmount).toBe('50.00');
    expect(releases).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// REFUND-005 — the number and the amount are frozen on the first attempt
// ---------------------------------------------------------------------------

describe('REFUND-005 — a retry may not change what was sent', () => {
  it('re-sends the frozen number instead of opening a second refund', async () => {
    const order = await paidOrder();
    const id = await approvedRefund(order, 1);

    expect((await service.executeRefund(racer(), id)).status).toBe('processing');
    const first = await refundRow(id);
    expect(first.requestContext).toMatchObject({ outTradeNo: order.outTradeNo });

    // A second send — the operator pressed again, or the sweep ran. WeChat
    // deduplicates on `out_refund_no` and hands back the refund it already has,
    // which is why freezing the number is the whole defence: the answer is
    // still `PROCESSING`, not a second 50 元.
    expect((await service.executeRefund(racer(), id)).status).toBe('processing');

    const after = await refundRow(id);
    expect(after.outRefundNo).toBe(first.outRefundNo);
    expect(gateway.refunds.size).toBe(1);
    expect(gateway.refunds.get(first.outRefundNo)).toBeDefined();
    expect(await flowRows('order_refund')).toEqual([]);

    // It settles once, when the gateway finally says so.
    gateway.markRefunded(first.outRefundNo, 'SUCCESS');
    expect(await service.reconcileRefund(racer(), id)).toMatchObject({ status: 'succeeded' });
    expect(await flowRows('order_refund')).toHaveLength(1);
    expect(gateway.refunds.size).toBe(1);
  });

  it('refuses a retry that asks for a different amount than the one frozen', async () => {
    const order = await paidOrder();
    const id = await approvedRefund(order, 1);
    expect((await service.executeRefund(racer(), id)).status).toBe('processing');

    // Somebody edited the row — a repair script, a half-finished feature.
    await harness.ctx.db.update(refunds).set({ amount: '90.00' }).where(eq(refunds.id, id));

    await expect(service.executeRefund(racer(), id)).rejects.toMatchObject({
      code: 'REFUND_AMOUNT_MISMATCH',
    });
    expect(gateway.refunds.size).toBe(1);
    expect(gateway.refunds.get((await refundRow(id)).outRefundNo)!.refundFen).toBe(5000);
  });

  it('never gives back more than the order was paid, across several requests', async () => {
    const order = await paidOrder();
    gateway.behaviour.refundStatus = 'SUCCESS';

    const first = await approvedRefund(order, 2);
    expect((await refundRow(first)).amount).toBe('100.00');
    expect((await service.executeRefund(racer(), first)).status).toBe('succeeded');

    await expect(
      service.apply(racer(userActor(order.userId)), applyBody(order, 1)),
    ).rejects.toMatchObject({ name: 'DomainError' });

    expect(await flowRows('order_refund')).toHaveLength(1);
    const after = await orderRow(order.orderId);
    expect(after.refundedAmount).toBe('100.00');
    expect(after.refundStatus).toBe('refunded');
    expect(after.status).toBe('refunded');
  });
});

// ---------------------------------------------------------------------------
// the gateway says no
// ---------------------------------------------------------------------------

describe('a refusal from the gateway is an answer, silence is not', () => {
  it('leaves a refused refund retryable, with nothing released', async () => {
    const order = await paidOrder();
    const id = await approvedRefund(order, 1);
    // The merchant account is short: the one refund failure operators meet.
    gateway.behaviour.refundBalanceFen = 1;

    const result = await service.executeRefund(racer(), id);
    expect(result.status).toBe('failed');

    const row = await refundRow(id);
    expect(row.status).toBe('failed');
    expect(row.lastError).toContain('NOT_ENOUGH');
    expect(row.lastErrorSummary).toBe('微信支付商户号余额不足，请到商户平台充值后重试');
    expect(await flowRows('order_refund')).toEqual([]);
    expect(releases).toEqual([]);
    expect((await orderRow(order.orderId)).refundedAmount).toBe('0.00');
  });

  it('keeps a silent refund in `unknown`, where only a query may move it', async () => {
    const order = await paidOrder();
    const id = await approvedRefund(order, 1);
    gateway.behaviour.dropNext = true;

    expect((await service.executeRefund(racer(), id)).status).toBe('unknown');
    const row = await refundRow(id);
    expect(row.status).toBe('unknown');
    expect(await flowRows('order_refund')).toEqual([]);

    // Nothing was sent, so the query finds nothing and the request becomes
    // retryable rather than silently succeeding.
    expect(gateway.refunds.size).toBe(0);
    await expect(repo.findRefund(harness.ctx.db, id)).resolves.toMatchObject({
      outRefundNo: row.outRefundNo,
    });
  });
});

describe('the review routes refuse what the console hides', () => {
  it('复核 does not pay out a 退货退款 whose goods have not come back', async () => {
    await harness.ctx.config.set(refundConfig, {
      returnName: '售后部',
      returnPhone: '13800000000',
      returnAddress: '浙江省杭州市西湖区文一西路 1 号',
    });
    const order = await paidOrder();
    const applied = await service.apply(racer(userActor(order.userId)), {
      ...applyBody(order, 1),
      kind: 'return_and_refund',
    });
    const id = Number(applied.id);
    await admin.adminApprove(racer(adminActor(order.adminId)), { id: String(id) });

    // 同意 on a return means "send the goods back", not "send the money".
    await expect(
      admin.adminRetry(racer(adminActor(order.adminId)), { id: String(id) }),
    ).rejects.toMatchObject({
      code: 'REFUND_NOT_ACTIONABLE',
      details: { status: 'approved', returnStage: 'awaiting_shipment' },
    });
    const row = await refundRow(id);
    expect(row.status).toBe('approved');
    expect(row.requestContext).toBeNull();
    expect(await flowRows('order_refund')).toHaveLength(0);
  });

  it('驳回 of an approved 仅退款 gives its units back to the line', async () => {
    const order = await paidOrder();
    const id = await approvedRefund(order, 2);
    const units = async () =>
      (
        await harness.ctx.db
          .select({ refunded: orderItems.refundedQuantity })
          .from(orderItems)
          .where(eq(orderItems.id, order.itemIds[0]!))
      )[0]!.refunded;
    expect(await units()).toBe(2);

    await admin.adminReject(racer(adminActor(order.adminId)), {
      id: String(id),
      rejectReason: '核实后不符合退款条件',
    });

    expect(await units()).toBe(0);
    // And the buyer can ask again for the whole line.
    await expect(
      service.apply(racer(userActor(order.userId)), applyBody(order, 2)),
    ).resolves.toMatchObject({ status: 'applied' });
  });
});

// ---------------------------------------------------------------------------
// REFUND-015 / REFUND-017 — units and lines follow the status
// ---------------------------------------------------------------------------

const lineUnits = async (order: PaidOrder) =>
  (
    await harness.ctx.db
      .select({
        refunded: orderItems.refundedQuantity,
        shipped: orderItems.shippedQuantity,
      })
      .from(orderItems)
      .where(eq(orderItems.id, order.itemIds[0]!))
  )[0]!;

/** An approved 仅退款 WeChat refused (the merchant account is short). */
async function failedRefund(order: PaidOrder, quantity = 1): Promise<number> {
  const id = await approvedRefund(order, quantity);
  gateway.behaviour.refundBalanceFen = 1;
  expect((await service.executeRefund(racer(), id)).status).toBe('failed');
  gateway.behaviour.refundBalanceFen = null;
  return id;
}

describe('REFUND-015 — the units a request holds follow its status', () => {
  it('REFUND-015 — a shopper withdrawing an approved 仅退款 hands its units back to the warehouse', async () => {
    const order = await paidOrder();
    const id = await approvedRefund(order, 2);
    expect((await lineUnits(order)).refunded).toBe(2);

    await service.cancel(racer(userActor(order.userId)), { id: String(id) });

    expect((await refundRow(id)).status).toBe('cancelled');
    expect((await lineUnits(order)).refunded).toBe(0);
    expect((await orderRow(order.orderId)).refundStatus).toBe('none');
  });
});

describe('REFUND-017 — a refused refund is still in flight', () => {
  it('REFUND-017 — keeps its lines and units, so the same units cannot be asked for twice', async () => {
    const order = await paidOrder();
    const id = await failedRefund(order, 2);

    expect((await lineUnits(order)).refunded).toBe(2);
    await expect(
      service.apply(racer(userActor(order.userId)), applyBody(order, 1)),
    ).rejects.toMatchObject({ code: 'REFUND_LINE_INVALID' });
    // Still in 进行中, and not something the shopper can delete.
    const open = await service.myList(racer(userActor(order.userId)), {
      state: 'open',
      page: 1,
      pageSize: 20,
    });
    expect(open.items.map((item) => item.id)).toEqual([String(id)]);
    await expect(
      service.hide(racer(userActor(order.userId)), { id: String(id) }),
    ).rejects.toMatchObject({ code: 'REFUND_NOT_ACTIONABLE' });
  });

  it('REFUND-017 — 复核 pays it under the same number', async () => {
    const order = await paidOrder();
    const id = await failedRefund(order);
    const { outRefundNo } = await refundRow(id);

    gateway.behaviour.refundStatus = 'SUCCESS';
    await admin.adminRetry(racer(adminActor(order.adminId)), { id: String(id) });

    const row = await refundRow(id);
    expect(row.status).toBe('succeeded');
    expect(row.outRefundNo).toBe(outRefundNo);
    expect((await lineUnits(order)).refunded).toBe(1);
  });

  it('REFUND-017 — the shopper may withdraw it, and the merchant may close it', async () => {
    const order = await paidOrder();
    const withdrawn = await failedRefund(order);
    await service.cancel(racer(userActor(order.userId)), { id: String(withdrawn) });
    expect((await lineUnits(order)).refunded).toBe(0);

    const closed = await failedRefund(order);
    await admin.adminReject(racer(adminActor(order.adminId)), {
      id: String(closed),
      rejectReason: '已线下退款',
    });
    expect((await refundRow(closed)).status).toBe('rejected');
    expect((await lineUnits(order)).refunded).toBe(0);
    // Closed, the lines are free for a new request.
    await expect(
      service.apply(racer(userActor(order.userId)), applyBody(order, 1)),
    ).resolves.toMatchObject({ status: 'applied' });
  });

  it('REFUND-015 — 复核 refuses a refund whose units shipped since it failed', async () => {
    const order = await paidOrder();
    const id = await failedRefund(order, 2);
    // A request that failed before failed ones kept their units: the units
    // went back to the warehouse, and the warehouse shipped them.
    await harness.ctx.db
      .update(orderItems)
      .set({ refundedQuantity: 0, shippedQuantity: 2 })
      .where(eq(orderItems.id, order.itemIds[0]!));

    gateway.behaviour.refundStatus = 'SUCCESS';
    await expect(
      admin.adminRetry(racer(adminActor(order.adminId)), { id: String(id) }),
    ).rejects.toMatchObject({ code: 'REFUND_LINE_ALREADY_SHIPPED' });
    expect((await refundRow(id)).status).toBe('failed');
    expect(gateway.refunds.size).toBe(0);
    expect(await lineUnits(order)).toEqual({ refunded: 0, shipped: 2 });
  });
});

describe('REFUND-019 — the shopper reads fixed lines, never what the gateway said', () => {
  it('REFUND-019 — shows a refused refund as 退款未完成 and keeps the gateway text for staff', async () => {
    const order = await paidOrder();
    const id = await failedRefund(order);
    const row = await refundRow(id);
    expect(row.lastError).not.toBeNull();

    const seen = await service.myDetail(racer(userActor(order.userId)), { id: String(id) });
    expect(seen.logs.at(-1)?.message).toBe('退款未完成，商家处理中');
    for (const log of seen.logs) {
      expect(log.message ?? '').not.toContain(row.lastError!);
      expect(log.message ?? '').not.toContain(gateway.keys.mchId);
    }

    const staff = await admin.adminDetail(racer(adminActor(order.adminId)), { id: String(id) });
    expect(staff.lastError).toBe(row.lastError);
    expect(staff.lastErrorSummary).toBe(row.lastErrorSummary);
    expect(staff.lastErrorSummary).not.toMatch(/[A-Z]{3,}/);
  });
});

describe('REFUND-020 — a full refund takes back the gift coupons the order earned', () => {
  it('REFUND-020 — revokes the unused gifts and returns them to the supply, leaving other coupons alone', async () => {
    const order = await paidOrder();
    const db = harness.ctx.db;
    const [template] = await db
      .insert(couponTemplates)
      .values({
        name: '下单赠券',
        status: 'active',
        claimMode: 'manual',
        discountAmount: '10.00',
        minSpend: '0.00',
        validityMode: 'days_after_claim',
        validDays: 30,
        isUnlimitedSupply: false,
        totalCount: 5,
        remainingCount: 3,
        perUserLimit: null,
      })
      .returning({ id: couponTemplates.id });
    const wallet = (claimSlot: number, gift: boolean) => ({
      templateId: template!.id,
      userId: order.userId,
      claimSlot,
      sourceKind: gift ? ('gift_order' as const) : ('claim' as const),
      ...(gift ? { sourceOrderId: order.orderId } : {}),
      title: '下单赠券',
      discountAmount: '10.00',
      minSpend: '0.00',
      status: 'unused' as const,
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      validTo: new Date('2026-12-31T00:00:00.000Z'),
    });
    const [gift] = await db
      .insert(userCoupons)
      .values(wallet(1, true))
      .returning({ id: userCoupons.id });
    const [claimed] = await db
      .insert(userCoupons)
      .values(wallet(2, false))
      .returning({ id: userCoupons.id });

    const id = await approvedRefund(order, 2);
    gateway.behaviour.refundStatus = 'SUCCESS';
    await service.executeRefund(racer(), id);
    expect((await orderRow(order.orderId)).refundStatus).toBe('refunded');

    const status = async (couponId: number) =>
      (await db.select().from(userCoupons).where(eq(userCoupons.id, couponId)))[0]!.status;
    expect(await status(gift!.id)).toBe('revoked');
    expect(await status(claimed!.id)).toBe('unused');
    const [after] = await db
      .select()
      .from(couponTemplates)
      .where(eq(couponTemplates.id, template!.id));
    expect(after!.remainingCount).toBe(4);
  });

  it('REFUND-020 — a partial refund leaves the gifts where they are', async () => {
    const order = await paidOrder();
    const db = harness.ctx.db;
    const [template] = await db
      .insert(couponTemplates)
      .values({
        name: '下单赠券',
        status: 'active',
        claimMode: 'manual',
        discountAmount: '10.00',
        minSpend: '0.00',
        validityMode: 'days_after_claim',
        validDays: 30,
        isUnlimitedSupply: true,
        perUserLimit: null,
      })
      .returning({ id: couponTemplates.id });
    const [gift] = await db
      .insert(userCoupons)
      .values({
        templateId: template!.id,
        userId: order.userId,
        claimSlot: 1,
        sourceKind: 'gift_order',
        sourceOrderId: order.orderId,
        title: '下单赠券',
        discountAmount: '10.00',
        minSpend: '0.00',
        status: 'unused',
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validTo: new Date('2026-12-31T00:00:00.000Z'),
      })
      .returning({ id: userCoupons.id });

    const id = await approvedRefund(order, 1);
    gateway.behaviour.refundStatus = 'SUCCESS';
    await service.executeRefund(racer(), id);
    expect((await orderRow(order.orderId)).refundStatus).toBe('partially_refunded');

    const [row] = await db.select().from(userCoupons).where(eq(userCoupons.id, gift!.id));
    expect(row!.status).toBe('unused');
  });
});
