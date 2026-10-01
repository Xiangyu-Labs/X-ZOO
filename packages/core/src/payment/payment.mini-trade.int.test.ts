import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { admins } from '@shop/db/schema/auth';
import { cartItems } from '@shop/db/schema/cart';
import { productSkus, productVirtualCards, products } from '@shop/db/schema/catalog';
import { orderItems, orderStatusLogs, orders } from '@shop/db/schema/order';
import { paymentAttempts, wechatTradeOrders } from '@shop/db/schema/payment';
import { expressCompanies } from '@shop/db/schema/reference';
import { effects as effectsTable } from '@shop/db/schema/system';
import { userAddresses, users } from '@shop/db/schema/user';
import {
  createTestCtx,
  flushTestRedis,
  forkTestCtx,
  runConcurrently,
  type TestCtx,
} from '@shop/testing';
import { buildMiniPush, startFakeOaServer, type FakeOaServer } from '@shop/testing/wechat';
import { registerCatalogDomain } from '../catalog';
import { drainEffects, findEffect, getEffectHandler } from '../effects';
import type { Actor, Ctx } from '../kernel/context';
import type { DomainError } from '../kernel/errors';
import { Money } from '../kernel/money';
import { withTx } from '../kernel/tx';
import { registerNotificationDomain } from '../notification';
import * as order from '../order';
import { onOrderPaid, registerOrderStateMachine, resetOrderPorts } from '../order/ports';
import { registerShippingFreightPort } from '../shipping';
import {
  handleMiniPush,
  MINI_PUSH_SCOPE,
  resetWechatTokenFlight,
  verifyMiniPushUrl,
  wechatConfig,
} from '../wechat';
import {
  adminListEffects,
  MINI_TRADE_MANAGED_EVENT,
  MSG_JUMP_PATH,
  SHIPPING_BLOCKED_EVENT,
  SHIPPING_OVERDUE_EVENT,
  miniTradeConfig,
  miniTradeStatus,
  registerPaymentDomain,
  syncMiniTrade,
  wechatReceipt,
} from './index';

/**
 * 小程序发货信息管理 (C07) against a real PostgreSQL and the fake
 * `api.weixin.qq.com`: what is reported when a parcel leaves, what WeChat's
 * pushes do, and who may hand the 确认收货 component a payment number.
 */

let harness: TestCtx;
let oa: FakeOaServer;

const NOW = '2026-06-01T00:00:00.000Z';
const TOKEN = 'mini-push-token-0001';
const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const MCH_ID = '1900000001';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW, platform: 'wechat-mini' });
  oa = await startFakeOaServer();
}, 180_000);

afterAll(async () => {
  await oa?.close();
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await flushTestRedis(harness.redis);
  harness.clock.set(NOW);
  harness.queue.reset();
  oa.reset();
  resetWechatTokenFlight();
  resetOrderPorts();
  registerCatalogDomain();
  registerShippingFreightPort();
  order.resetFulfilmentPorts();
  registerOrderStateMachine(order.orderStateMachine);
  order.installFulfilmentHooks();
  registerNotificationDomain();
  registerPaymentDomain();
  await harness.ctx.config.set(wechatConfig, {
    miniAppId: oa.miniAppId,
    miniAppSecret: oa.miniAppSecret,
    apiBaseUrl: oa.url,
    miniToken: TOKEN,
    miniAesKey: AES_KEY,
    miniMessageMode: 'safe',
  });
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

type Kind = 'physical' | 'virtual_card';

async function makeProduct(kind: Kind = 'physical'): Promise<{ productId: number; skuId: number }> {
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
    await harness.ctx.db.insert(productVirtualCards).values(
      Array.from({ length: 3 }, () => {
        sequence += 1;
        return {
          productId: product!.id,
          skuId: sku!.id,
          cardKey: `KEY-${sequence}`,
          cardNo: `NO-${sequence}`,
          cardSecret: `SEC-${sequence}`,
        };
      }),
    );
  }
  return { productId: product!.id, skuId: sku!.id };
}

async function makeExpressCompany(name: string, wechatDeliveryId: string | null): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(expressCompanies)
    .values({ code: `c-${sequence}`, name, wechatDeliveryId })
    .returning({ id: expressCompanies.id });
  return row!.id;
}

interface Placed {
  userId: number;
  orderId: number;
  itemIds: number[];
  transactionId: string;
  outTradeNo: string;
}

/** A paid order, paid through `channel`, with a paid attempt WeChat knows. */
async function paidOrder(
  lines: { productId: number; skuId: number; quantity?: number }[],
  channel: 'wechat_mini' | 'wechat_oa' = 'wechat_mini',
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
  sequence += 1;
  const detail = await order.create(as(userId), {
    source: 'cart',
    cartItemIds: [],
    kind: 'normal',
    idempotencyKey: `mini-trade-${sequence.toString().padStart(10, '0')}`,
  });
  const orderId = Number(detail.id);
  const transactionId = `42000000${orderId.toString().padStart(8, '0')}`;
  const outTradeNo = `P${orderId.toString().padStart(12, '0')}`;
  await harness.ctx.db.insert(paymentAttempts).values({
    orderId,
    outTradeNo,
    channel,
    mchId: MCH_ID,
    appId: channel === 'wechat_mini' ? oa.miniAppId : oa.appId,
    amount: '60.00',
    payerUserId: userId,
    context: { tradeType: 'JSAPI', openid: `o-payer-${userId}` },
    status: 'paid',
    transactionId,
    paidAt: harness.ctx.clock.now(),
  });
  await withTx(harness.ctx.db, async (tx) => {
    const moved = await order.orderStateMachine.transition(
      tx,
      orderId,
      ['pending_payment'],
      'paid',
      {
        at: harness.ctx.clock.now(),
        paidAmount: '60.00',
        transactionNo: transactionId,
      },
    );
    if (!moved.won) throw new Error('could not mark the order paid');
    const [row] = await tx.select().from(orders).where(eq(orders.id, orderId));
    await onOrderPaid.dispatch(tx, harness.ctx, {
      orderId,
      orderNo: row!.orderNo,
      userId,
      paidAmount: Money.parse('60.00'),
      at: harness.ctx.clock.now(),
      transactionId,
    });
  });
  const items = await harness.ctx.db
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(orderItems.id);
  harness.queue.reset();
  return { userId, orderId, itemIds: items.map((item) => item.id), transactionId, outTradeNo };
}

const expressBody = (
  companyId: number,
  trackingNo: string,
  lines: { orderItemId: string; quantity: number }[] = [],
) => ({
  deliveryMode: 'express' as const,
  expressCompanyId: String(companyId),
  trackingNo,
  lines,
});

const courierBody = (lines: { orderItemId: string; quantity: number }[]) => ({
  deliveryMode: 'merchant_delivery' as const,
  courierName: '李师傅',
  courierPhone: '13900000000',
  lines,
});

const uploads = () => oa.callsTo('/wxa/sec/order/upload_shipping_info');
const uploadBodies = () => uploads().map((call) => call.body as Record<string, unknown>);
const tradeRow = async (orderId: number) =>
  (
    await harness.ctx.db
      .select()
      .from(wechatTradeOrders)
      .where(eq(wechatTradeOrders.orderId, orderId))
  )[0];
const orderRow = async (orderId: number) =>
  (await harness.ctx.db.select().from(orders).where(eq(orders.id, orderId)))[0]!;
const receivedLogs = (orderId: number) =>
  harness.ctx.db
    .select()
    .from(orderStatusLogs)
    .where(and(eq(orderStatusLogs.orderId, orderId), eq(orderStatusLogs.toStatus, 'received')));
const uploadEffect = (shipmentId: string) =>
  findEffect(harness.ctx.db, {
    scope: 'shipment',
    scopeId: shipmentId,
    eventType: 'wechat.uploadShipping',
  });
const notificationRows = (event: string) =>
  harness.ctx.db
    .select({ scopeId: effectsTable.scopeId })
    .from(effectsTable)
    .then((rows) => rows.filter((row) => row.scopeId.startsWith(`${event}:`)));

const drain = () => drainEffects(harness.ctx);

/** A push as WeChat sends it, stamped with the harness clock. */
function push(message: Record<string, unknown>, mode: 'safe' | 'plain' = 'safe') {
  return buildMiniPush({
    token: TOKEN,
    aesKey: AES_KEY,
    appId: oa.miniAppId,
    message,
    mode,
    timestamp: Math.floor(harness.ctx.clock.now().getTime() / 1000),
  });
}

const settlement = (placed: Placed, extra: Record<string, unknown> = {}) => ({
  ToUserName: 'gh_fakemini00001',
  FromUserName: 'o-wechat',
  CreateTime: 1_780_000_000,
  MsgType: 'event',
  Event: 'trade_manage_order_settlement',
  transaction_id: placed.transactionId,
  merchant_id: MCH_ID,
  merchant_trade_no: placed.outTradeNo,
  confirm_receive_method: 1,
  confirm_receive_time: 1_780_000_000,
  settlement_time: 0,
  ...extra,
});

// ---------------------------------------------------------------------------
// upload_shipping_info
// ---------------------------------------------------------------------------

describe('reporting a shipment of a mini-program payment', () => {
  it('uploads one unified express shipment with the carrier’s WeChat code — WXSHIP-001', async () => {
    const product = await makeProduct();
    const yto = await makeExpressCompany('圆通速递', 'YTO');
    const placed = await paidOrder([{ ...product, quantity: 2 }]);
    const adminId = await makeAdmin();

    const shipment = await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      expressBody(yto, 'YT0001'),
    );
    expect(uploads()).toHaveLength(0); // after commit, never inside the transaction
    await drain();

    expect(uploadBodies()).toEqual([
      {
        order_key: { order_number_type: 2, transaction_id: placed.transactionId },
        logistics_type: 1,
        delivery_mode: 1,
        shipping_list: [
          {
            tracking_no: 'YT0001',
            express_company: 'YTO',
            item_desc: expect.stringMatching(/×2$/),
          },
        ],
        upload_time: '2026-06-01T08:00:00.000+08:00',
        payer: { openid: `o-payer-${placed.userId}` },
      },
    ]);
    expect((await uploadEffect(shipment.id))?.status).toBe('done');
    const trade = await tradeRow(placed.orderId);
    expect(trade).toMatchObject({ outTradeNo: placed.outTradeNo, mchId: MCH_ID });
    expect(trade!.uploadedAt).not.toBeNull();
    expect(trade!.allDeliveredAt).not.toBeNull();
    expect(oa.tradeOrder(placed.transactionId)?.orderState).toBe(2);
  });

  it('adds the masked receiver phone for 顺丰 — WXSHIP-001', async () => {
    const product = await makeProduct();
    const sf = await makeExpressCompany('顺丰速运', 'SF');
    const placed = await paidOrder([product]);
    await order.adminShip(
      asAdmin(await makeAdmin()),
      { id: String(placed.orderId) },
      expressBody(sf, 'SF0001'),
    );
    await drain();
    const [body] = uploadBodies();
    expect((body!['shipping_list'] as unknown[])[0]).toMatchObject({
      express_company: 'SF',
      contact: { receiver_contact: '138****8000' },
    });
    expect(oa.tradeOrder(placed.transactionId)?.orderState).toBe(2);
  });

  it('reports a split delivery in parts, the last one saying all delivered — WXSHIP-001', async () => {
    const a = await makeProduct();
    const b = await makeProduct();
    const yto = await makeExpressCompany('圆通速递', 'YTO');
    const placed = await paidOrder([a, b]);
    const adminId = await makeAdmin();

    await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      expressBody(yto, 'PART1', [{ orderItemId: String(placed.itemIds[0]), quantity: 1 }]),
    );
    await drain();
    expect(oa.tradeOrder(placed.transactionId)?.orderState).toBe(1);
    expect((await tradeRow(placed.orderId))!.allDeliveredAt).toBeNull();

    await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      expressBody(yto, 'PART2', [{ orderItemId: String(placed.itemIds[1]), quantity: 1 }]),
    );
    await drain();

    expect(uploadBodies().map((body) => [body['delivery_mode'], body['is_all_delivered']])).toEqual(
      [
        [2, false],
        [2, true],
      ],
    );
    expect(oa.tradeOrder(placed.transactionId)?.orderState).toBe(2);
    expect((await tradeRow(placed.orderId))!.allDeliveredAt).not.toBeNull();
  });

  it('reports a virtual delivery as logistics_type 3 without a waybill — WXSHIP-001', async () => {
    const card = await makeProduct('virtual_card');
    const placed = await paidOrder([card]);
    await drain(); // the paid hook's auto-delivery, then the upload it causes
    const [body] = uploadBodies();
    expect(body).toMatchObject({ logistics_type: 3, delivery_mode: 1 });
    expect(body!['shipping_list']).toEqual([{ item_desc: expect.stringMatching(/×1$/) }]);
    expect(oa.tradeOrder(placed.transactionId)?.orderState).toBe(2);
  });

  it('reports nothing for a payment made outside the mini program, or while switched off — WXSHIP-001', async () => {
    const product = await makeProduct();
    const yto = await makeExpressCompany('圆通速递', 'YTO');
    const adminId = await makeAdmin();

    const oaPaid = await paidOrder([product], 'wechat_oa');
    const shipment = await order.adminShip(
      asAdmin(adminId),
      { id: String(oaPaid.orderId) },
      expressBody(yto, 'YT-OA'),
    );
    await harness.ctx.config.set(miniTradeConfig, { uploadEnabled: false });
    const off = await paidOrder([product]);
    await order.adminShip(
      asAdmin(adminId),
      { id: String(off.orderId) },
      expressBody(yto, 'YT-OFF'),
    );
    await drain();

    expect(uploads()).toHaveLength(0);
    expect(await uploadEffect(shipment.id)).toBeNull();
    expect(await tradeRow(off.orderId)).toBeUndefined();
  });

  it('waits, retrying, while the carrier has no WeChat code — and sends once it is filled in — WXSHIP-002', async () => {
    const product = await makeProduct();
    const nameless = await makeExpressCompany('某快递', null);
    const placed = await paidOrder([product]);
    const shipment = await order.adminShip(
      asAdmin(await makeAdmin()),
      { id: String(placed.orderId) },
      expressBody(nameless, 'X0001'),
    );
    await drain();
    expect(uploads()).toHaveLength(0);
    const waiting = await uploadEffect(shipment.id);
    expect(waiting?.status).not.toBe('done');
    expect(waiting?.lastError ?? '').toMatch(/微信快递编码/);
    // Written for the operator, so it is what 待处理任务 shows them too.
    expect(waiting?.lastErrorSummary).toBe(waiting?.lastError);

    await harness.ctx.db
      .update(expressCompanies)
      .set({ wechatDeliveryId: 'ZTO' })
      .where(eq(expressCompanies.id, nameless));
    harness.clock.advance(3_600_000);
    await drain();
    expect(uploads()).toHaveLength(1);
    expect((await uploadEffect(shipment.id))?.status).toBe('done');
  });

  it('reports a split delivery with no express part once, as 统一发货, when the last part leaves — WXSHIP-009', async () => {
    const a = await makeProduct();
    const b = await makeProduct();
    const placed = await paidOrder([a, b]);
    const adminId = await makeAdmin();

    await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      courierBody([{ orderItemId: String(placed.itemIds[0]), quantity: 1 }]),
    );
    await drain();
    expect(uploads()).toHaveLength(0);

    const last = await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      courierBody([{ orderItemId: String(placed.itemIds[1]), quantity: 1 }]),
    );
    await drain();

    const bodies = uploadBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ logistics_type: 2, delivery_mode: 1 });
    // One package describing both parts.
    const [pkg] = bodies[0]!['shipping_list'] as Array<{ item_desc: string }>;
    expect(pkg!.item_desc.split('；')).toHaveLength(2);
    expect((await uploadEffect(last.id))?.status).toBe('done');
    expect(oa.tradeOrder(placed.transactionId)?.orderState).toBe(2);
    expect((await tradeRow(placed.orderId))!.allDeliveredAt).not.toBeNull();
    expect(await notificationRows(SHIPPING_BLOCKED_EVENT)).toEqual([]);
  });

  it('tells staff at dispatch when the last part cannot follow express parts — WXSHIP-009', async () => {
    const a = await makeProduct();
    const b = await makeProduct();
    const yto = await makeExpressCompany('圆通速递', 'YTO');
    const placed = await paidOrder([a, b]);
    const adminId = await makeAdmin();

    await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      expressBody(yto, 'PART1', [{ orderItemId: String(placed.itemIds[0]), quantity: 1 }]),
    );
    await drain();
    const last = await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      courierBody([{ orderItemId: String(placed.itemIds[1]), quantity: 1 }]),
    );
    await drain();

    // WeChat got the express part and nothing it would refuse.
    expect(uploadBodies().map((body) => [body['delivery_mode'], body['is_all_delivered']])).toEqual(
      [[2, false]],
    );
    expect(await notificationRows(SHIPPING_BLOCKED_EVENT)).toEqual([
      { scopeId: `${SHIPPING_BLOCKED_EVENT}:shipment:${last.id}` },
    ]);
  });

  it('tells staff once when an upload waits on a carrier code, however often it retries — WXSHIP-009', async () => {
    const product = await makeProduct();
    const nameless = await makeExpressCompany('某快递', null);
    const placed = await paidOrder([product]);
    const adminId = await makeAdmin();
    const shipment = await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      expressBody(nameless, 'X0002'),
    );
    await drain();
    harness.clock.advance(3_600_000);
    await drain();

    expect(uploads()).toHaveLength(0);
    expect(await notificationRows(SHIPPING_BLOCKED_EVENT)).toEqual([
      { scopeId: `${SHIPPING_BLOCKED_EVENT}:shipment:${shipment.id}` },
    ]);
    // …and the waiting upload is on the 待处理任务 console, not only in a log.
    const listed = await adminListEffects(asAdmin(adminId), {
      page: 1,
      pageSize: 20,
      status: 'pending',
      scope: 'shipment',
    });
    expect(listed.items.map((item) => [item.scopeId, item.eventType])).toContainEqual([
      shipment.id,
      'wechat.uploadShipping',
    ]);
  });

  it('retries a WeChat refusal, and finishes on “already shipped” — WXSHIP-002', async () => {
    const product = await makeProduct();
    const yto = await makeExpressCompany('圆通速递', 'YTO');
    const placed = await paidOrder([product]);
    oa.behaviour.failShipping = { errcode: -1, errmsg: 'system error' };
    const shipment = await order.adminShip(
      asAdmin(await makeAdmin()),
      { id: String(placed.orderId) },
      expressBody(yto, 'YT0002'),
    );
    await drain();
    expect((await uploadEffect(shipment.id))?.status).not.toBe('done');

    // WeChat took it after all (the answer was lost): the replay is 10060002.
    oa.behaviour.failShipping = { errcode: 10060002, errmsg: '支付单已完成发货' };
    harness.clock.advance(3_600_000);
    await drain();
    expect((await uploadEffect(shipment.id))?.status).toBe('done');
    expect((await tradeRow(placed.orderId))!.uploadedAt).not.toBeNull();
  });

  it('corrects a reported waybill once, as WeChat allows, and never twice — WXSHIP-003', async () => {
    const product = await makeProduct();
    const yto = await makeExpressCompany('圆通速递', 'YTO');
    const placed = await paidOrder([product]);
    const adminId = await makeAdmin();
    const shipment = await order.adminShip(
      asAdmin(adminId),
      { id: String(placed.orderId) },
      expressBody(yto, 'WRONG1'),
    );
    await drain();

    await order.updateShipment(asAdmin(adminId), { id: shipment.id }, { trackingNo: 'RIGHT1' });
    await drain();
    await order.updateShipment(asAdmin(adminId), { id: shipment.id }, { trackingNo: 'RIGHT2' });
    await drain();

    expect(
      uploadBodies().map(
        (body) => (body['shipping_list'] as { tracking_no: string }[])[0]!.tracking_no,
      ),
    ).toEqual(['WRONG1', 'RIGHT1']);
    expect((await tradeRow(placed.orderId))!.correctedAt).not.toBeNull();
    expect(oa.tradeOrder(placed.transactionId)?.corrected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the push URL
// ---------------------------------------------------------------------------

describe('POST /api/v1/webhooks/wechat-mini', () => {
  async function shippedMiniOrder(): Promise<Placed> {
    const product = await makeProduct();
    const yto = await makeExpressCompany('圆通速递', 'YTO');
    const placed = await paidOrder([product]);
    await order.adminShip(
      asAdmin(await makeAdmin()),
      { id: String(placed.orderId) },
      expressBody(yto, `YT${placed.orderId}`),
    );
    await drain();
    return placed;
  }

  it('answers the URL check only when it is signed with our token — WXSHIP-004', async () => {
    const good = push({}, 'plain');
    expect(await verifyMiniPushUrl(harness.ctx, { ...good.query, echostr: 'echo-1' })).toEqual({
      status: 200,
      body: 'echo-1',
    });
    expect(
      await verifyMiniPushUrl(harness.ctx, {
        ...good.query,
        signature: 'f'.repeat(40),
        echostr: 'x',
      }),
    ).toMatchObject({ status: 403 });
  });

  it('moves the order to received on a settlement push, once, however often WeChat repeats it — WXSHIP-005', async () => {
    const placed = await shippedMiniOrder();
    const delivery = push(settlement(placed));

    expect(await handleMiniPush(harness.ctx, delivery)).toEqual({ status: 200, body: 'success' });
    expect(await handleMiniPush(harness.ctx, delivery)).toEqual({ status: 200, body: 'success' });
    // A re-delivery under a fresh signature decrypts to the same message.
    harness.clock.advance(60_000);
    expect(await handleMiniPush(harness.ctx, push(settlement(placed)))).toMatchObject({
      status: 200,
    });
    await drain();

    expect((await orderRow(placed.orderId)).status).toBe('received');
    const logs = await receivedLogs(placed.orderId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ operatorKind: 'gateway', message: '用户在微信确认收货' });
    const trade = await tradeRow(placed.orderId);
    expect(trade).toMatchObject({ confirmSource: 'manual' });
    expect(trade!.confirmedAt?.toISOString()).toBe(new Date(1_780_000_000 * 1000).toISOString());
    const recorded = await harness.ctx.db
      .select()
      .from(effectsTable)
      .where(eq(effectsTable.scope, MINI_PUSH_SCOPE));
    expect(recorded).toHaveLength(1);
  });

  it('stamps the settlement when the money moves, without moving the order again — WXSHIP-005', async () => {
    const placed = await shippedMiniOrder();
    await handleMiniPush(harness.ctx, push(settlement(placed, { confirm_receive_method: 2 })));
    await drain();
    harness.clock.advance(60_000);
    await handleMiniPush(harness.ctx, push(settlement(placed, { settlement_time: 1_780_100_000 })));
    await drain();

    const trade = await tradeRow(placed.orderId);
    expect(trade).toMatchObject({ confirmSource: 'auto' });
    expect(trade!.settledAt).not.toBeNull();
    expect(await receivedLogs(placed.orderId)).toHaveLength(1);
  });

  it('refuses a bad signature, a plaintext push in 安全模式, a stale one and a reused nonce — WXSHIP-004', async () => {
    const placed = await shippedMiniOrder();
    const good = push(settlement(placed));

    const forged = { ...good, query: { ...good.query, msg_signature: '0'.repeat(40) } };
    expect(await handleMiniPush(harness.ctx, forged)).toMatchObject({ status: 403 });

    const plain = push(settlement(placed), 'plain');
    expect(await handleMiniPush(harness.ctx, plain)).toMatchObject({ status: 403 });

    const stale = buildMiniPush({
      token: TOKEN,
      aesKey: AES_KEY,
      appId: oa.miniAppId,
      message: settlement(placed),
      mode: 'safe',
      timestamp: Math.floor(harness.ctx.clock.now().getTime() / 1000) - 600,
    });
    expect(await handleMiniPush(harness.ctx, stale)).toMatchObject({ status: 403 });

    expect(await handleMiniPush(harness.ctx, good)).toMatchObject({ status: 200 });
    const other = push(settlement(placed, { settlement_time: 1 }));
    const replayed = { query: good.query, body: other.body };
    expect(await handleMiniPush(harness.ctx, replayed)).toMatchObject({ status: 403 });

    const sealedForAnother = buildMiniPush({
      token: TOKEN,
      aesKey: AES_KEY,
      appId: 'wxsomeoneelse000001',
      message: settlement(placed),
      mode: 'safe',
      timestamp: Math.floor(harness.ctx.clock.now().getTime() / 1000),
    });
    expect(await handleMiniPush(harness.ctx, sealedForAnother)).toMatchObject({ status: 403 });

    await drain();
    const recorded = await harness.ctx.db
      .select()
      .from(effectsTable)
      .where(eq(effectsTable.scope, MINI_PUSH_SCOPE));
    expect(recorded).toHaveLength(1);
  });

  it('accepts plain JSON when 明文模式 is configured, and drops events nobody handles — WXSHIP-004', async () => {
    await harness.ctx.config.set(wechatConfig, { miniMessageMode: 'plain' });
    const placed = await shippedMiniOrder();
    expect(await handleMiniPush(harness.ctx, push(settlement(placed), 'plain'))).toMatchObject({
      status: 200,
    });
    expect(
      await handleMiniPush(
        harness.ctx,
        push({ MsgType: 'event', Event: 'user_enter_tempsession' }, 'plain'),
      ),
    ).toEqual({ status: 200, body: 'success' });
    await drain();
    expect((await orderRow(placed.orderId)).status).toBe('received');
    const recorded = await harness.ctx.db
      .select()
      .from(effectsTable)
      .where(eq(effectsTable.scope, MINI_PUSH_SCOPE));
    expect(recorded).toHaveLength(1);
  });

  it('tells operators about WeChat’s shipping reminder and about being put under management — WXSHIP-007', async () => {
    const product = await makeProduct();
    const placed = await paidOrder([product]);
    await handleMiniPush(
      harness.ctx,
      push({
        MsgType: 'event',
        Event: 'trade_manage_remind_shipping',
        transaction_id: placed.transactionId,
        merchant_id: MCH_ID,
        merchant_trade_no: placed.outTradeNo,
        msg: '请尽快发货',
      }),
    );
    harness.clock.advance(1000);
    await handleMiniPush(
      harness.ctx,
      push({ MsgType: 'event', Event: 'trade_manage_remind_access_api', msg: '已纳入' }),
    );
    await drain();

    expect(await notificationRows(SHIPPING_OVERDUE_EVENT)).toEqual([
      { scopeId: `${SHIPPING_OVERDUE_EVENT}:order:${placed.orderId}` },
    ]);
    expect(await notificationRows(MINI_TRADE_MANAGED_EVENT)).toHaveLength(1);
    const status = await miniTradeStatus(asAdmin(await makeAdmin()));
    expect(status.managed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the 确认收货 component
// ---------------------------------------------------------------------------

describe('the 确认收货 component', () => {
  async function shipped(): Promise<Placed> {
    const product = await makeProduct();
    const yto = await makeExpressCompany('圆通速递', 'YTO');
    const placed = await paidOrder([product]);
    await order.adminShip(
      asAdmin(await makeAdmin()),
      { id: String(placed.orderId) },
      expressBody(yto, `YT${placed.orderId}`),
    );
    await drain();
    return placed;
  }

  it('hands the payment number to the order’s owner only — WXSHIP-006', async () => {
    const placed = await shipped();
    expect(await wechatReceipt(as(placed.userId), { id: String(placed.orderId) })).toEqual({
      receipt: { transactionId: placed.transactionId },
    });
    const stranger = await makeUser();
    await expect(wechatReceipt(as(stranger), { id: String(placed.orderId) })).rejects.toMatchObject(
      { code: 'ORDER_NOT_FOUND' },
    );
  });

  it('answers null for an order WeChat was not told about — WXSHIP-006', async () => {
    const product = await makeProduct();
    const yto = await makeExpressCompany('圆通速递', 'YTO');
    const placed = await paidOrder([product], 'wechat_oa');
    await order.adminShip(
      asAdmin(await makeAdmin()),
      { id: String(placed.orderId) },
      expressBody(yto, 'YT-OA'),
    );
    await drain();
    expect(await wechatReceipt(as(placed.userId), { id: String(placed.orderId) })).toEqual({
      receipt: null,
    });
  });

  it('moves the order only once WeChat’s get_order says the buyer confirmed — WXSHIP-006', async () => {
    const placed = await shipped();
    const confirm = () =>
      order.confirmReceipt(
        as(placed.userId),
        { id: String(placed.orderId) },
        { via: 'wechat-component' },
      );

    await expect(confirm()).rejects.toMatchObject({
      code: 'ORDER_WECHAT_RECEIPT_UNCONFIRMED',
      details: { verdict: 'not-confirmed' },
    });
    expect((await orderRow(placed.orderId)).status).toBe('shipped');

    oa.behaviour.dropNext = true;
    await expect(confirm()).rejects.toMatchObject({
      code: 'ORDER_WECHAT_RECEIPT_UNCONFIRMED',
      details: { verdict: 'unavailable' },
    });

    oa.setTradeOrderState(placed.transactionId, 3);
    const detail = await confirm();
    expect(detail.status).toBe('received');
    expect(await tradeRow(placed.orderId)).toMatchObject({ confirmSource: 'component' });
  });

  it('refuses the component path for an order that was never reported — WXSHIP-006', async () => {
    const product = await makeProduct();
    const yto = await makeExpressCompany('圆通速递', 'YTO');
    const placed = await paidOrder([product], 'wechat_oa');
    await order.adminShip(
      asAdmin(await makeAdmin()),
      { id: String(placed.orderId) },
      expressBody(yto, 'YT-OA'),
    );
    oa.setTradeOrderState(placed.transactionId, 3);
    await expect(
      order.confirmReceipt(
        as(placed.userId),
        { id: String(placed.orderId) },
        { via: 'wechat-component' },
      ),
    ).rejects.toMatchObject({ code: 'ORDER_WECHAT_RECEIPT_UNCONFIRMED' });
  });

  it('leaves one receipt when the settlement push and the buyer’s tap race — WXSHIP-005', async () => {
    const placed = await shipped();
    await handleMiniPush(harness.ctx, push(settlement(placed)));
    const [pushed] = await harness.ctx.db
      .select()
      .from(effectsTable)
      .where(eq(effectsTable.scope, MINI_PUSH_SCOPE));
    const handler = getEffectHandler(MINI_PUSH_SCOPE, 'trade_manage_order_settlement')!;

    const report = await runConcurrently(2, async (index) => {
      if (index === 0) {
        await handler(forkTestCtx(harness), {
          id: pushed!.id,
          scope: pushed!.scope,
          scopeId: pushed!.scopeId,
          eventType: pushed!.eventType,
          payload: pushed!.payload,
          attempts: 1,
        });
        return 'push';
      }
      await order.confirmReceipt(
        forkTestCtx(harness, { actor: userActor(placed.userId), platform: 'wechat-mini' }),
        { id: String(placed.orderId) },
      );
      return 'tap';
    });

    // Whichever lost did nothing: the buyer's tap loses with ORDER_NOT_RECEIVABLE,
    // the push with a no-op.
    expect(
      report.rejected.every(
        (error) => (error as { code?: string }).code === 'ORDER_NOT_RECEIVABLE',
      ),
    ).toBe(true);
    expect((await orderRow(placed.orderId)).status).toBe('received');
    expect(await receivedLogs(placed.orderId)).toHaveLength(1);
    expect((await tradeRow(placed.orderId))!.confirmedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the admin's 同步
// ---------------------------------------------------------------------------

describe('同步 (is_trade_managed + set_msg_jump_path)', () => {
  it('records WeChat’s answer and points messages at the order page — WXSHIP-007', async () => {
    const adminId = await makeAdmin();
    const before = await miniTradeStatus(asAdmin(adminId));
    expect(before).toMatchObject({
      managed: null,
      msgJumpPath: null,
      expectedMsgJumpPath: MSG_JUMP_PATH,
    });

    const after = await syncMiniTrade(asAdmin(adminId));
    expect(after).toMatchObject({ managed: true, msgJumpPath: MSG_JUMP_PATH });
    expect(after.msgJumpPathSetAt).toBe(NOW);
    expect(oa.msgJumpPath).toBe(MSG_JUMP_PATH);
    // The catalogue's `order` page, with WeChat's own placeholder for the payment.
    expect(MSG_JUMP_PATH).toBe('packages/order/detail/index?outTradeNo=${商品订单号}');
  });

  it('says so when the mini program is not configured, and when WeChat refuses — WXSHIP-007', async () => {
    const adminId = await makeAdmin();
    await harness.ctx.config.set(wechatConfig, { miniAppSecret: '' });
    await expect(syncMiniTrade(asAdmin(adminId))).rejects.toMatchObject({
      code: 'PAYMENT_MINI_NOT_CONFIGURED',
    });
    await harness.ctx.config.set(wechatConfig, { miniAppSecret: oa.miniAppSecret });
    oa.behaviour.failNext = { errcode: 48001, errmsg: 'api unauthorized' };
    // The toast reads what the code means in Chinese; WeChat's own errmsg
    // ('api unauthorized') is in the log and not in the answer (AGENTS rule 1).
    const refused = await syncMiniTrade(asAdmin(adminId)).then(
      () => null,
      (caught: unknown) => caught as DomainError,
    );
    expect(refused).toMatchObject({
      code: 'PAYMENT_MINI_TRADE_SYNC_FAILED',
      message:
        '同步微信发货信息管理失败：这个公众号或小程序没有该接口的权限（账号类型或认证状态不满足）（错误码 48001）',
      details: { step: 'is_trade_managed', errcode: 48001 },
    });
    expect(JSON.stringify(refused?.details)).not.toContain('unauthorized');
  });

  it('is an admin’s, not a shopper’s — WXSHIP-007', async () => {
    const userId = await makeUser();
    await expect(syncMiniTrade(as(userId))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
