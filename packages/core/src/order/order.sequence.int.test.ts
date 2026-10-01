import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { cartItems } from '@shop/db/schema/cart';
import { productSkus, products } from '@shop/db/schema/catalog';
import { groupbuyActivities, groupbuyActivitySkus, groupbuyGroups } from '@shop/db/schema/groupbuy';
import { orderItems, orders } from '@shop/db/schema/order';
import { paymentAttempts } from '@shop/db/schema/payment';
import { presaleActivities, presaleActivitySkus } from '@shop/db/schema/presale';
import { refundItems, refunds } from '@shop/db/schema/refund';
import { effects as effectsTable } from '@shop/db/schema/system';
import { userAddresses, users } from '@shop/db/schema/user';
import { admins } from '@shop/db/schema/auth';
import {
  createTestCtx,
  flushTestRedis,
  startFakeWechatGateway,
  type FakeWechatGateway,
  type TestCtx,
} from '@shop/testing';
import { registerAllDomains } from '../domains.gen';
import { dispatchEffectsOnce, drainEffects } from '../effects';
import { Money } from '../kernel/money';
import type { Actor, Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { handleTransactionNotify, paymentConfig, startPayment } from '../payment';
import { sweepPresaleWindows } from '../presale';
import * as refundAdmin from '../refund';
import * as refundService from '../refund';
import { countsUnits } from '../refund';
import { registerShippingFreightPort } from '../shipping';
import { wechatConfig } from '../wechat';
import * as order from './index';
import { resolveStockPort } from './catalog.port';
import { COMMIT_SALE_HOOK } from './order.stock.hooks';
import { onOrderPaid, resetOrderPorts } from './ports';

/**
 * SEQ-001 — a fixed-seed interleaving of real operations.
 *
 * Every other integration test in this repository asks one question: put the
 * system in state X, do Y, assert Z. That finds the defects somebody thought
 * of. This file exists for the ones nobody thought of: it drives the *real*
 * services — checkout, payment and after-sales against the fake WeChat gateway,
 * fulfilment, group buy, the presale windows and the two sweeps the worker runs
 * — in an order chosen by a seeded PRNG, and after **every single step** it
 * re-checks eight properties that must hold no matter what happened before.
 *
 * Eight invariants, from the ledger row:
 *
 *  1. a cancelled order holds no collectible payment;
 *  2. a paid attempt carries its trade number;
 *  3. money taken at the gateway is recorded locally;
 *  4. completed refunds never exceed the payment;
 *  5. every stock layer keeps each unit in stock, reserved by a live line, or
 *     sold;
 *  6. the effects ledger has no duplicate `(aggregate, event)`;
 *  7. `order_items.refunded_quantity` is exactly the units its refunds count
 *     (REFUND-015) — through withdraw, reject, a refused send and 复核;
 *  8. a unit is shipped or taken by a refund before shipping, never both
 *     (`shipped + refunded <= quantity`, for the refunds that took their units
 *     while the line was unshipped; a 仅退款 approved after dispatch is a
 *     money-only refund and legitimately counts shipped units).
 *
 * **A refusal is a legal outcome.** Cancelling a paid order, paying a
 * cancelled one, approving a refund twice — the sequence tries all of them,
 * and a `DomainError` is recorded in the log and the run continues. What is
 * *not* legal is an invariant that stops holding, or any error that is not a
 * `DomainError` (that is a 500 on a real server). Either one fails the test
 * and prints the seed together with the whole event log, so the run replays
 * exactly.
 *
 * The world: three ordinary shoppers with one two-unit order each, placed
 * through checkout; a two-seat group buy whose every join becomes a fourth,
 * fifth, … shopper the same moves act on; a presale campaign whose window the
 * sweep flips 100 minutes in. The worker's effects dispatcher is one of the
 * moves, and the ledger is drained and the eight properties re-checked once more
 * after the last step.
 *
 * Four seeds, fixed, 150 steps each. `SHOP_SEQ_SEEDS=1,2,3` and
 * `SHOP_SEQ_STEPS=400` widen it for a soak run without editing the file
 * (STAB-001 uses the defaults).
 *
 * Two things it found are pinned at the bottom as ordinary tests: a paid
 * order's units are counted as sold (the paid hook commits the sale), and
 * `order.paid`/`order.refunded` effects are delivered, not parked as `unknown`.
 */

let harness: TestCtx;
let gateway: FakeWechatGateway;

const NOW = '2026-06-01T00:00:00.000Z';

/** Fixed, and committed: a seed that found something must stay in the suite. */
const DEFAULT_SEEDS = [0x5eed_0001, 0x5eed_0002, 0x5eed_0003, 0x5eed_0004];
const SEEDS = (process.env.SHOP_SEQ_SEEDS ?? '')
  .split(',')
  .map((part) => Number.parseInt(part.trim(), 10))
  .filter((value) => Number.isFinite(value));
const seeds = SEEDS.length > 0 ? SEEDS : DEFAULT_SEEDS;
const STEPS = Number.parseInt(process.env.SHOP_SEQ_STEPS ?? '', 10) || 150;

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW, platform: 'h5' });
  // The gateway shares the context's clock: `verifyNotification` checks the
  // signature timestamp against `ctx.clock`, and a real-time gateway signing
  // for a context pinned to 2026 would look hours stale.
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
  harness.queue.reset();
  gateway.transactions.clear();
  gateway.refunds.clear();
  gateway.calls.length = 0;
  gateway.behaviour.failNext = null;
  gateway.behaviour.dropNext = false;
  gateway.behaviour.signResponsesWithWrongKey = false;
  gateway.behaviour.refundBalanceFen = null;
  gateway.behaviour.refundStatus = 'PROCESSING';

  // What the web process and the worker install, and nothing less: a hook or
  // an effect handler missing here would be a move the sequence silently skips.
  resetOrderPorts();
  registerAllDomains();
  registerShippingFreightPort();

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
});

afterEach(() => {
  resetOrderPorts();
  registerAllDomains();
  registerShippingFreightPort();
});

// ---------------------------------------------------------------------------
// the seeded PRNG
// ---------------------------------------------------------------------------

/**
 * mulberry32 — 32 bits of state, uniform enough for choosing the next move and
 * short enough to read. What matters is that it is *ours*: `Math.random()`
 * would make a failure unreproducible, which is the one thing this file cannot
 * afford.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// the world
// ---------------------------------------------------------------------------

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });
const adminActor = (id: number): Actor => ({ kind: 'admin', id, permissions: [], isSuper: true });

const as = (userId: number): Ctx => harness.as(userActor(userId));
const asAdmin = (adminId: number): Ctx => harness.as(adminActor(adminId));

interface Shopper {
  userId: number;
  productId: number;
  skuId: number;
  /** Stock the SKU was created with. Invariant 5 is measured against it. */
  initialStock: number;
  orderId: number;
  /** Set once `startPayment` has run for the live attempt. */
  outTradeNo: string | null;
  /** `markPaid` has been called at the gateway for this number. */
  paidAtGateway: Set<string>;
  /** A `TRANSACTION.SUCCESS` for this number has been handed to the app. */
  notified: Set<string>;
}

interface World {
  shoppers: Shopper[];
  adminId: number;
  /** Every SKU whose stock invariant is checked, with the stock it started at. */
  skuStock: Map<number, number>;
  groupbuy: {
    activityId: number;
    productId: number;
    skuId: number;
    initialStock: number;
    /** Shoppers minted for joins, so a join always has a fresh buyer. */
    joiners: number[];
    nextJoiner: number;
    openGroupId: number | null;
  };
  presale: { activityId: number; skuId: number; endAt: Date; swept: number };
  /**
   * Refunds approved while every one of their lines was unshipped: their units
   * are the ones fulfilment must never ship (invariant 8).
   */
  reservedUnshipped: Set<number>;
}

let sequence = 0;

async function makeUser(prefix: string): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({ account: `${prefix}-${sequence}`, nickname: `顾客${sequence}` })
    .returning({ id: users.id });
  await harness.ctx.db.insert(userAddresses).values({
    userId: row!.id,
    receiverName: '张三',
    receiverPhone: '13800138000',
    provinceName: '浙江省',
    cityName: '杭州市',
    districtName: '西湖区',
    detail: '文三路 100 号',
    isDefault: true,
  });
  return row!.id;
}

async function makeSku(
  name: string,
  price: string,
  stock: number,
): Promise<{ productId: number; skuId: number }> {
  sequence += 1;
  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `${name}${sequence}`,
      status: 'on_shelf',
      imageUrl: 'https://cdn.example.test/p.jpg',
      price,
      stock,
      freightMode: 'free',
    })
    .returning({ id: products.id });
  const [sku] = await harness.ctx.db
    .insert(productSkus)
    .values({
      productId: product!.id,
      skuCode: `SEQ-${sequence}`,
      specText: '默认',
      price,
      stock,
      isDefault: true,
    })
    .returning({ id: productSkus.id });
  return { productId: product!.id, skuId: sku!.id };
}

/** One ordinary shopper with one ordinary two-unit order, through checkout. */
async function makeShopper(world: World): Promise<Shopper> {
  const userId = await makeUser('seq-user');
  const { productId, skuId } = await makeSku('测试商品', '60.00', 10);
  const [cartRow] = await harness.ctx.db
    .insert(cartItems)
    .values({ userId, productId, skuId, quantity: 2, isSelected: true })
    .returning({ id: cartItems.id });

  sequence += 1;
  const detail = await order.create(as(userId), {
    source: 'cart',
    cartItemIds: [String(cartRow!.id)],
    kind: 'normal',
    idempotencyKey: `seq-${String(sequence).padStart(10, '0')}`,
  });
  world.skuStock.set(skuId, 10);

  return {
    userId,
    productId,
    skuId,
    initialStock: 10,
    orderId: Number(detail.id),
    outTradeNo: null,
    paidAtGateway: new Set(),
    notified: new Set(),
  };
}

async function buildWorld(): Promise<World> {
  sequence = 0;
  const [operator] = await harness.ctx.db
    .insert(admins)
    .values({ account: 'seq-admin', passwordHash: 'x'.repeat(60), name: '运营', isSuper: true })
    .returning({ id: admins.id });

  const world: World = {
    shoppers: [],
    adminId: operator!.id,
    skuStock: new Map(),
    reservedUnshipped: new Set(),
    groupbuy: {
      activityId: 0,
      productId: 0,
      skuId: 0,
      initialStock: 0,
      joiners: [],
      nextJoiner: 0,
      openGroupId: null,
    },
    presale: { activityId: 0, skuId: 0, endAt: new Date(0), swept: 0 },
  };

  for (let i = 0; i < 3; i += 1) world.shoppers.push(await makeShopper(world));

  // --- the group-buy activity -----------------------------------------------
  const gb = await makeSku('拼团坚果', '88.00', 200);
  const [activity] = await harness.ctx.db
    .insert(groupbuyActivities)
    .values({
      productId: gb.productId,
      title: '两人成团',
      imageUrl: 'https://cdn.example.test/p.jpg',
      status: 'active',
      price: '59.00',
      originalPrice: '88.00',
      seatsRequired: 2,
      groupTtlSeconds: 86_400,
      stock: 40,
      perOrderQuantity: 2,
      startAt: new Date('2026-05-01T00:00:00.000Z'),
      endAt: new Date('2026-07-01T00:00:00.000Z'),
    })
    .returning({ id: groupbuyActivities.id });
  await harness.ctx.db.insert(groupbuyActivitySkus).values({
    activityId: activity!.id,
    skuId: gb.skuId,
    price: '59.00',
    stock: 40,
    isEnabled: true,
  });
  world.groupbuy = {
    activityId: activity!.id,
    productId: gb.productId,
    skuId: gb.skuId,
    initialStock: 40,
    joiners: [],
    nextJoiner: 0,
    openGroupId: null,
  };
  world.skuStock.set(gb.skuId, 200);
  for (let i = 0; i < 8; i += 1) world.groupbuy.joiners.push(await makeUser('seq-gb'));

  // --- the presale activity -------------------------------------------------
  const ps = await makeSku('春茶预售', '108.00', 200);
  const endAt = new Date(Date.parse(NOW) + 100 * 60_000);
  const [presale] = await harness.ctx.db
    .insert(presaleActivities)
    .values({
      productId: ps.productId,
      title: '春茶预售 · 明前龙井',
      status: 'active',
      paymentMode: 'full',
      price: '58.00',
      stock: 40,
      perOrderQuantity: 3,
      startAt: new Date('2026-05-01T00:00:00.000Z'),
      endAt,
      shipAfterDays: 15,
    })
    .returning({ id: presaleActivities.id });
  await harness.ctx.db.insert(presaleActivitySkus).values({
    activityId: presale!.id,
    skuId: ps.skuId,
    price: '58.00',
    stock: 40,
    isEnabled: true,
  });
  world.presale = { activityId: presale!.id, skuId: ps.skuId, endAt, swept: 0 };
  world.skuStock.set(ps.skuId, 200);

  harness.queue.reset();
  return world;
}

// ---------------------------------------------------------------------------
// the operations
// ---------------------------------------------------------------------------

type Step = (world: World, rng: () => number) => Promise<string>;

const pick = <T>(rng: () => number, values: readonly T[]): T =>
  values[Math.floor(rng() * values.length)]!;

const someShopper = (world: World, rng: () => number) => pick(rng, world.shoppers);

/**
 * A shopper the step can actually act on — three times in four.
 *
 * A uniform choice over three shoppers and sixteen moves almost never lands
 * the chain 立即支付 → 网关收款 → 回调 on one order, so a purely uniform walk
 * spends its whole budget on no-ops and proves nothing. Biasing the *subject*
 * towards one the move applies to keeps the walk productive while leaving the
 * *order* of moves entirely to the seed — and the remaining quarter still
 * aims a move at a shopper it cannot possibly work on, which is how the
 * refusals (cancel a paid order, ship an unpaid one) keep being exercised.
 */
function choose(world: World, rng: () => number, eligible: (shopper: Shopper) => boolean): Shopper {
  const ready = world.shoppers.filter(eligible);
  if (ready.length > 0 && rng() < 0.75) return pick(rng, ready);
  return someShopper(world, rng);
}

/** Every refund of one order, whatever state the sequence has left it in. */
async function refundsOf(orderId: number) {
  return harness.ctx.db.select().from(refunds).where(eq(refunds.orderId, orderId));
}

/** Statuses, once per step, so the eligibility filters cost one query. */
async function statuses(world: World): Promise<Map<number, string>> {
  const rows = await harness.ctx.db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(
      inArray(
        orders.id,
        world.shoppers.map((shopper) => shopper.orderId),
      ),
    );
  return new Map(rows.map((row) => [row.id, row.status]));
}

/** Refund states of the three orders, read once per step beside the statuses. */
async function refundStates(world: World): Promise<Array<{ orderId: number; status: string }>> {
  return harness.ctx.db
    .select({ orderId: refunds.orderId, status: refunds.status })
    .from(refunds)
    .where(
      inArray(
        refunds.orderId,
        world.shoppers.map((shopper) => shopper.orderId),
      ),
    );
}

/** Filled in before each step so the eligibility predicates can read it. */
let currentStatuses = new Map<number, string>();
const statusOf = (shopper: Shopper): string => currentStatuses.get(shopper.orderId) ?? 'gone';

/** Refund statuses, read once per step alongside the order statuses. */
let currentRefunds: Array<{ orderId: number; status: string }> = [];

const ordersWithRefund = (wanted: readonly string[]): Set<number> =>
  new Set(currentRefunds.filter((row) => wanted.includes(row.status)).map((row) => row.orderId));

/** The same bias, for the moves whose precondition is a refund in some state. */
function chooseWithRefund(world: World, rng: () => number, wanted: readonly string[]): Shopper {
  const ids = ordersWithRefund(wanted);
  return choose(world, rng, (shopper) => ids.has(shopper.orderId));
}

const REFUNDABLE_ORDER = ['paid', 'shipped', 'received', 'completed'];

/**
 * The moves, with weights. A uniform draw over twenty-one moves cancels an order
 * about as often as it pays one, and the three orders are all gone before the
 * three-step payment chain (立即支付 → 网关收款 → 回调) has come up once — the
 * walk would refuse its way to the end and prove nothing. So the moves that
 * advance money are drawn three times as often as the ones that end an order;
 * the *order* of moves is still entirely the seed's.
 */
const STEP_WEIGHTS = {
  openSheet: 3,
  payAtGateway: 3,
  deliverNotification: 3,
  duplicateNotification: 1,
  cancelOrder: 1,
  advanceClock: 1,
  sweepExpired: 1,
  applyRefund: 2,
  approveRefund: 2,
  executeRefund: 2,
  executeRefundRefused: 1,
  withdrawRefund: 1,
  rejectRefund: 1,
  retryRefund: 1,
  refundNotification: 2,
  ship: 2,
  confirmReceipt: 1,
  sweepAutoReceive: 1,
  groupbuyJoin: 1,
  presaleWindowSweep: 1,
  dispatchEffects: 2,
} as const;

type StepName = keyof typeof STEP_WEIGHTS;

const STEP_NAMES: readonly StepName[] = (Object.keys(STEP_WEIGHTS) as StepName[]).flatMap((name) =>
  Array.from({ length: STEP_WEIGHTS[name] }, () => name),
);

const STEPS_BY_NAME: Record<StepName, Step> = {
  /** 立即支付: a gateway order and an open attempt. */
  async openSheet(world, rng) {
    const shopper = choose(world, rng, (s) => statusOf(s) === 'pending_payment');
    const intent = await startPayment(as(shopper.userId), {
      orderId: shopper.orderId,
      channel: 'wechat_mini',
      openid: `oFake${shopper.userId}`,
    });
    shopper.outTradeNo = intent.outTradeNo;
    return `openSheet order=${shopper.orderId} outTradeNo=${intent.outTradeNo}`;
  },

  /** The shopper completed payment in WeChat. The money is now at the gateway. */
  async payAtGateway(world, rng) {
    const shopper = choose(
      world,
      rng,
      (s) => s.outTradeNo !== null && !s.paidAtGateway.has(s.outTradeNo),
    );
    if (shopper.outTradeNo === null) return `payAtGateway order=${shopper.orderId} (no attempt)`;
    // WeChat only takes money for a transaction that is still open: a closed
    // one (cancel called `close`) or one past its `time_expire` shows the
    // shopper an error instead. `markPaid` forces SUCCESS unconditionally, so
    // the driver plays the gateway's part here.
    const transaction = gateway.transactions.get(shopper.outTradeNo);
    const expired =
      transaction !== undefined &&
      transaction.expiresAtMs !== null &&
      transaction.expiresAtMs <= harness.clock.now().getTime();
    if (
      transaction === undefined ||
      !['NOTPAY', 'USERPAYING'].includes(transaction.tradeState) ||
      expired
    ) {
      const why = expired ? 'expired' : (transaction?.tradeState ?? 'unknown');
      return `payAtGateway order=${shopper.orderId} outTradeNo=${shopper.outTradeNo} gateway refuses (${why})`;
    }
    gateway.markPaid(shopper.outTradeNo);
    shopper.paidAtGateway.add(shopper.outTradeNo);
    return `payAtGateway order=${shopper.orderId} outTradeNo=${shopper.outTradeNo}`;
  },

  /** WeChat calls us back. This is the only thing that books the money locally. */
  async deliverNotification(world, rng) {
    const shopper = choose(
      world,
      rng,
      (s) =>
        s.outTradeNo !== null && s.paidAtGateway.has(s.outTradeNo) && !s.notified.has(s.outTradeNo),
    );
    const outTradeNo = shopper.outTradeNo;
    if (outTradeNo === null || !shopper.paidAtGateway.has(outTradeNo)) {
      return `deliverNotification order=${shopper.orderId} (nothing paid)`;
    }
    const ack = await handleTransactionNotify(
      harness.as(userActor(shopper.userId)),
      gateway.signTransactionNotification({ outTradeNo }),
    );
    if (ack.status === 200) shopper.notified.add(outTradeNo);
    return `deliverNotification order=${shopper.orderId} outTradeNo=${outTradeNo} ack=${ack.status}`;
  },

  /**
   * WeChat delivers the same bytes again — the ordinary case, not an attack.
   * PAY-007 says the money is booked once however many times it arrives.
   */
  async duplicateNotification(world, rng) {
    const shopper = choose(
      world,
      rng,
      (s) => s.outTradeNo !== null && s.notified.has(s.outTradeNo),
    );
    const outTradeNo = shopper.outTradeNo;
    if (outTradeNo === null || !shopper.notified.has(outTradeNo)) {
      return `duplicateNotification order=${shopper.orderId} (never notified)`;
    }
    const signed = gateway.signTransactionNotification({ outTradeNo });
    const first = await handleTransactionNotify(harness.ctx, signed);
    const second = await handleTransactionNotify(harness.ctx, signed);
    return `duplicateNotification order=${shopper.orderId} acks=${first.status},${second.status}`;
  },

  async cancelOrder(world, rng) {
    const shopper = choose(world, rng, (s) => statusOf(s) === 'pending_payment');
    const detail = await order.cancel(
      as(shopper.userId),
      { id: String(shopper.orderId) },
      { reason: '不想要了' },
    );
    return `cancelOrder order=${shopper.orderId} -> ${detail.status}`;
  },

  /**
   * 1–20 minutes. Everything time-dependent downstream moves with it.
   *
   * Then the 未付款提醒 job runs for every order, whatever it has become: it
   * reminds about one still awaiting payment inside its window, and never
   * about one paid, cancelled or expired (ORDER-015). It rides on this move
   * rather than being one, so it draws nothing from the seed and every seed
   * keeps the walk it was committed with.
   */
  async advanceClock(world, rng) {
    const minutes = 1 + Math.floor(rng() * 20);
    harness.clock.set(new Date(harness.clock.now().getTime() + minutes * 60_000));
    const reminded: number[] = [];
    for (const shopper of world.shoppers) {
      const [row] = await harness.ctx.db
        .select({ status: orders.status, payExpiresAt: orders.payExpiresAt })
        .from(orders)
        .where(eq(orders.id, shopper.orderId));
      const payable =
        row?.status === 'pending_payment' &&
        row.payExpiresAt !== null &&
        row.payExpiresAt > harness.clock.now();
      const outcome = await order.remindUnpaid(harness.ctx, { orderId: shopper.orderId });
      expect(outcome.sent, `remindUnpaid order=${shopper.orderId} status=${row?.status}`).toBe(
        payable,
      );
      if (outcome.sent) reminded.push(shopper.orderId);
    }
    return `advanceClock +${minutes}m -> ${harness.clock.now().toISOString()} reminded=[${reminded.join(',')}]`;
  },

  async sweepExpired(_world) {
    const report = await order.sweepExpiredOrders(harness.ctx);
    return `sweepExpired ${JSON.stringify(report)}`;
  },

  async applyRefund(world, rng) {
    const shopper = choose(world, rng, (s) => REFUNDABLE_ORDER.includes(statusOf(s)));
    const [item] = await harness.ctx.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, shopper.orderId));
    const quantity = 1 + Math.floor(rng() * 2);
    const detail = await refundService.apply(as(shopper.userId), {
      orderId: String(shopper.orderId),
      kind: 'refund_only',
      lines: [{ orderItemId: String(item!.id), quantity }],
      reason: '不想要了',
      images: [],
      includeFreight: false,
    });
    return `applyRefund order=${shopper.orderId} refund=${detail.id} qty=${quantity}`;
  },

  async approveRefund(world, rng) {
    const shopper = chooseWithRefund(world, rng, ['applied']);
    const open = (await refundsOf(shopper.orderId)).filter((row) => row.status === 'applied');
    if (open.length === 0) return `approveRefund order=${shopper.orderId} (nothing applied)`;
    const target = pick(rng, open);
    const shippedBefore = await harness.ctx.db
      .select({ shipped: orderItems.shippedQuantity })
      .from(refundItems)
      .innerJoin(orderItems, eq(orderItems.id, refundItems.orderItemId))
      .where(eq(refundItems.refundId, target.id));
    await refundAdmin.adminApprove(asAdmin(world.adminId), { id: String(target.id) });
    if (shippedBefore.every((line) => line.shipped === 0)) world.reservedUnshipped.add(target.id);
    return `approveRefund order=${shopper.orderId} refund=${target.id}`;
  },

  /** WeChat refuses the send (the merchant account is short): the refund is `failed`. */
  async executeRefundRefused(world, rng) {
    const shopper = chooseWithRefund(world, rng, ['approved']);
    const approved = (await refundsOf(shopper.orderId)).filter((row) => row.status === 'approved');
    if (approved.length === 0) return `executeRefundRefused order=${shopper.orderId} (none)`;
    const target = pick(rng, approved);
    gateway.behaviour.refundBalanceFen = 1;
    try {
      const result = await refundService.executeRefund(harness.ctx, target.id);
      return `executeRefundRefused refund=${target.id} -> ${result.status}`;
    } finally {
      gateway.behaviour.refundBalanceFen = null;
    }
  },

  /** 撤销申请 — the inverse of applying, from applied, approved or failed. */
  async withdrawRefund(world, rng) {
    const shopper = chooseWithRefund(world, rng, ['applied', 'approved', 'failed']);
    const open = (await refundsOf(shopper.orderId)).filter((row) =>
      ['applied', 'approved', 'failed'].includes(row.status),
    );
    if (open.length === 0) return `withdrawRefund order=${shopper.orderId} (nothing open)`;
    const target = pick(rng, open);
    await refundService.cancel(as(target.userId), { id: String(target.id) });
    return `withdrawRefund refund=${target.id} (was ${target.status})`;
  },

  /** 拒绝 / 关闭 — the merchant's inverse of approving, and the way out of `failed`. */
  async rejectRefund(world, rng) {
    const shopper = chooseWithRefund(world, rng, ['applied', 'approved', 'failed']);
    const open = (await refundsOf(shopper.orderId)).filter((row) =>
      ['applied', 'approved', 'failed'].includes(row.status),
    );
    if (open.length === 0) return `rejectRefund order=${shopper.orderId} (nothing open)`;
    const target = pick(rng, open);
    await refundAdmin.adminReject(asAdmin(world.adminId), {
      id: String(target.id),
      rejectReason: '核实后不符合退款条件',
    });
    return `rejectRefund refund=${target.id} (was ${target.status})`;
  },

  /** 复核 — send a refused refund again, or ask WeChat about one in flight. */
  async retryRefund(world, rng) {
    const shopper = chooseWithRefund(world, rng, ['failed', 'unknown', 'processing']);
    const retryable = (await refundsOf(shopper.orderId)).filter((row) =>
      ['failed', 'unknown', 'processing'].includes(row.status),
    );
    if (retryable.length === 0) return `retryRefund order=${shopper.orderId} (nothing to retry)`;
    const target = pick(rng, retryable);
    const detail = await refundAdmin.adminRetry(asAdmin(world.adminId), { id: String(target.id) });
    return `retryRefund refund=${target.id} ${target.status} -> ${detail.status}`;
  },

  /** What the effects dispatcher would do: send the approved refund to WeChat. */
  async executeRefund(world, rng) {
    const shopper = chooseWithRefund(world, rng, ['approved', 'processing', 'unknown', 'failed']);
    const sendable = (await refundsOf(shopper.orderId)).filter((row) =>
      ['approved', 'processing', 'unknown', 'failed'].includes(row.status),
    );
    if (sendable.length === 0) return `executeRefund order=${shopper.orderId} (nothing approved)`;
    const target = pick(rng, sendable);
    const result = await refundService.executeRefund(harness.ctx, target.id);
    return `executeRefund refund=${target.id} -> ${result.status}`;
  },

  /** The gateway settles asynchronously and calls the refund webhook. */
  async refundNotification(world, rng) {
    const shopper = chooseWithRefund(world, rng, ['processing']);
    const inFlight = (await refundsOf(shopper.orderId)).filter(
      (row) => row.status === 'processing' && row.outRefundNo !== null,
    );
    if (inFlight.length === 0)
      return `refundNotification order=${shopper.orderId} (none in flight)`;
    const target = pick(rng, inFlight);
    gateway.markRefunded(target.outRefundNo!, 'SUCCESS');
    const signed = gateway.signRefundNotification({ outRefundNo: target.outRefundNo! });
    const ack = await refundService.handleRefundNotify(harness.ctx, signed);
    return `refundNotification refund=${target.id} ack=${ack.status}`;
  },

  async ship(world, rng) {
    const shopper = choose(world, rng, (s) => statusOf(s) === 'paid');
    const shipment = await order.shipOrder(asAdmin(world.adminId), {
      orderId: shopper.orderId,
      body: {
        deliveryMode: 'merchant_delivery',
        lines: [],
        courierName: '王五',
        courierPhone: '13900000000',
      },
      operatorAdminId: world.adminId,
    });
    return `ship order=${shopper.orderId} shipment=${shipment.id}`;
  },

  async confirmReceipt(world, rng) {
    const shopper = choose(world, rng, (s) => statusOf(s) === 'shipped');
    const detail = await order.confirmReceipt(as(shopper.userId), {
      id: String(shopper.orderId),
    });
    return `confirmReceipt order=${shopper.orderId} -> ${detail.status}`;
  },

  async sweepAutoReceive() {
    const report = await order.sweepAutoReceive(harness.ctx);
    return `sweepAutoReceive ${JSON.stringify(report)}`;
  },

  /**
   * A fresh buyer opens or joins the open team, through the real checkout, so
   * the group-buy stock ledger and the catalogue's move together or not at all.
   */
  async groupbuyJoin(world, rng) {
    const gb = world.groupbuy;
    if (gb.nextJoiner >= gb.joiners.length) return 'groupbuyJoin (no joiners left)';
    const userId = gb.joiners[gb.nextJoiner]!;
    gb.nextJoiner += 1;
    sequence += 1;

    const meta: { activityId: string; groupId?: string } = { activityId: String(gb.activityId) };
    if (gb.openGroupId !== null && rng() < 0.7) meta.groupId = String(gb.openGroupId);

    const detail = await order.create(as(userId), {
      source: 'buy-now',
      cartItemIds: [],
      item: { skuId: String(gb.skuId), quantity: 1 },
      kind: 'groupbuy',
      kindMeta: meta,
      idempotencyKey: `seq-gb-${String(sequence).padStart(10, '0')}`,
    });

    // Remember whichever team is still forming, so the next join can land in it.
    const [open] = await harness.ctx.db
      .select({ id: groupbuyGroups.id })
      .from(groupbuyGroups)
      .where(
        and(eq(groupbuyGroups.activityId, gb.activityId), eq(groupbuyGroups.status, 'forming')),
      )
      .limit(1);
    gb.openGroupId = open?.id ?? null;

    // From here on the joiner is a shopper like the other three: their order
    // can be paid (which is what closes a team), cancelled, refunded, shipped.
    world.shoppers.push({
      userId,
      productId: gb.productId,
      skuId: gb.skuId,
      initialStock: gb.initialStock,
      orderId: Number(detail.id),
      outTradeNo: null,
      paidAtGateway: new Set(),
      notified: new Set(),
    });

    return `groupbuyJoin user=${userId} order=${detail.id} group=${gb.openGroupId ?? 'none'}`;
  },

  /**
   * One pass of the worker's effects dispatcher: the refund it sends to WeChat,
   * the group-buy expiry, the notifications. Retries are not delayed — the
   * clock only moves when `advanceClock` says so.
   */
  async dispatchEffects() {
    const report = await dispatchEffectsOnce(harness.ctx, { baseBackoffMs: 0, maxBackoffMs: 0 });
    return `dispatchEffects ${JSON.stringify(report)}`;
  },

  /** The presale window sweep: opens what has started, closes what has ended. */
  async presaleWindowSweep(world) {
    const report = await sweepPresaleWindows(harness.ctx);
    world.presale.swept += 1;
    return `presaleWindowSweep ${JSON.stringify(report)}`;
  },
};

// ---------------------------------------------------------------------------
// the invariants
// ---------------------------------------------------------------------------

const fen = (value: string | null): number => Money.parseOrZero(value).fen;

/** Every check returns the violations it found, as readable sentences. */
async function checkInvariants(world: World): Promise<string[]> {
  const broken: string[] = [];
  const db = harness.ctx.db;

  const orderRows = await db.select().from(orders);
  const itemRows = await db.select().from(orderItems);
  const attemptRows = await db.select().from(paymentAttempts);
  const refundRows = await db.select().from(refunds);
  const byOrder = new Map(orderRows.map((row) => [row.id, row]));

  // --- 1. a cancelled order holds no collectible payment ---------------------
  for (const attempt of attemptRows) {
    const row = byOrder.get(attempt.orderId);
    if (row?.status !== 'cancelled') continue;
    if (!['closed', 'failed'].includes(attempt.status)) {
      broken.push(
        `INV1 order ${attempt.orderId} is cancelled but attempt ${attempt.outTradeNo} is '${attempt.status}' — money could still arrive`,
      );
    }
    const transaction = gateway.transactions.get(attempt.outTradeNo);
    if (transaction?.tradeState === 'SUCCESS') {
      broken.push(
        `INV1 order ${attempt.orderId} is cancelled but the gateway says ${attempt.outTradeNo} is SUCCESS`,
      );
    }
  }
  // …and the other direction: money booked locally forbids `cancelled`.
  for (const row of orderRows) {
    if (row.status === 'cancelled' && row.paidAmount !== null) {
      broken.push(`INV1 order ${row.id} is cancelled and yet carries paidAmount ${row.paidAmount}`);
    }
  }

  // --- 2. a paid attempt carries its trade number ----------------------------
  for (const attempt of attemptRows) {
    if (attempt.status !== 'paid') continue;
    if (attempt.transactionId === null || attempt.paidAt === null) {
      broken.push(
        `INV2 attempt ${attempt.outTradeNo} is 'paid' with transactionId=${String(attempt.transactionId)} paidAt=${String(attempt.paidAt)}`,
      );
    }
    const row = byOrder.get(attempt.orderId);
    if (row !== undefined && row.transactionNo !== attempt.transactionId) {
      broken.push(
        `INV2 order ${attempt.orderId} carries transactionNo=${String(row.transactionNo)} but its paid attempt carries ${String(attempt.transactionId)}`,
      );
    }
  }

  // --- 3. money taken at the gateway is recorded locally ---------------------
  // Only for the numbers the sequence has both paid *and* delivered a
  // notification for: money sitting at the gateway with the callback still in
  // flight is not yet ours to have recorded.
  for (const shopper of world.shoppers) {
    for (const outTradeNo of shopper.notified) {
      const attempt = attemptRows.find((row) => row.outTradeNo === outTradeNo);
      const transaction = gateway.transactions.get(outTradeNo);
      if (attempt === undefined) {
        broken.push(`INV3 the gateway took money for ${outTradeNo} and there is no local attempt`);
        continue;
      }
      if (attempt.status !== 'paid') {
        broken.push(
          `INV3 ${outTradeNo} was paid and acknowledged, but the local attempt is '${attempt.status}'`,
        );
        continue;
      }
      if (transaction !== undefined && fen(attempt.amount) !== transaction.amountFen) {
        broken.push(
          `INV3 ${outTradeNo}: the gateway took ${transaction.amountFen} fen, the local attempt says ${fen(attempt.amount)}`,
        );
      }
      const row = byOrder.get(attempt.orderId);
      if (row !== undefined && (row.paidAmount === null || row.paidAt === null)) {
        broken.push(`INV3 order ${attempt.orderId} has a paid attempt but is not marked paid`);
      }
    }
  }

  // --- 4. completed refunds never exceed the payment -------------------------
  for (const row of orderRows) {
    const paid = fen(row.paidAmount);
    const settled = refundRows
      .filter((refund) => refund.orderId === row.id && refund.status === 'succeeded')
      .reduce((total, refund) => total + fen(refund.amount), 0);
    if (settled > paid) {
      broken.push(`INV4 order ${row.id}: ${settled} fen refunded against ${paid} fen paid`);
    }
    if (fen(row.refundedAmount) > paid) {
      broken.push(
        `INV4 order ${row.id}: refundedAmount ${row.refundedAmount} exceeds paidAmount ${String(row.paidAmount)}`,
      );
    }
  }

  // --- 5. no unit is created or destroyed ------------------------------------
  // A unit leaves the shelf when a line is placed and comes back exactly once:
  // when the order is cancelled (the line then counts for nothing), or when a
  // refund of an undispatched line settles — which the catalogue marks with a
  // `('refund', id, 'catalog.stock.release')` row in the effects ledger. A
  // `refund_only` takes its units at approval but gives them back only on
  // success, so between the two they are on no shelf and in no live line; this
  // formula is the one that stays exact through that window.
  const refundItemRows = await db.select().from(refundItems);
  const restocked = new Set(
    (
      await db
        .select({ scopeId: effectsTable.scopeId })
        .from(effectsTable)
        .where(
          and(
            eq(effectsTable.scope, 'refund'),
            eq(effectsTable.eventType, 'catalog.stock.release'),
          ),
        )
    ).map((row) => Number(row.scopeId)),
  );
  const itemById = new Map(itemRows.map((item) => [item.id, item]));
  const skuRows = await db
    .select()
    .from(productSkus)
    .where(inArray(productSkus.id, [...world.skuStock.keys()]));
  for (const sku of skuRows) {
    const initial = world.skuStock.get(sku.id)!;
    let placed = 0; // taken off the shelf by a line that was not cancelled
    let paid = 0; // of those, on an order whose payment was booked
    for (const item of itemRows) {
      if (item.skuId !== sku.id) continue;
      const row = byOrder.get(item.orderId);
      if (row === undefined || row.status === 'cancelled') continue;
      placed += item.quantity;
      if (row.paidAt !== null) paid += item.quantity;
    }
    let returned = 0; // put back by a settled refund
    for (const line of refundItemRows) {
      if (!restocked.has(line.refundId)) continue;
      if (itemById.get(line.orderItemId)?.skuId !== sku.id) continue;
      returned += line.quantity;
    }
    if (sku.stock + placed - returned !== initial) {
      broken.push(
        `INV5 sku ${sku.id}: stock ${sku.stock} + placed ${placed} - restocked ${returned} != initial ${initial}`,
      );
    }
    // `sales` counts exactly the units that were paid for and not put back: the
    // paid hook commits the sale, and the one release that takes it back is a
    // settled refund's restock of an undispatched line — the same `returned` as
    // above. A refunded line that had already shipped is not restocked (the
    // operator's inbound step decides whether it is sellable), so its units
    // stay both off the shelf and in `sales`.
    const sold = paid - returned;
    if (sku.sales !== sold) {
      broken.push(
        `INV5 sku ${sku.id}: sales ${sku.sales} != paid ${paid} - restocked ${returned} (${sold})`,
      );
    }
    if (sku.stock < 0 || sku.sales < 0) {
      broken.push(`INV5 sku ${sku.id}: negative stock/sales (${sku.stock}/${sku.sales})`);
    }
  }

  // The group-buy ledger is a second layer over the same units.
  const [gbActivity] = await db
    .select()
    .from(groupbuyActivities)
    .where(eq(groupbuyActivities.id, world.groupbuy.activityId));
  const [gbSku] = await db
    .select()
    .from(groupbuyActivitySkus)
    .where(eq(groupbuyActivitySkus.activityId, world.groupbuy.activityId));
  for (const [label, ledger] of [
    ['activity', gbActivity],
    ['sku', gbSku],
  ] as const) {
    if (ledger === undefined) continue;
    if (ledger.stock + ledger.sales > world.groupbuy.initialStock) {
      broken.push(
        `INV5 group-buy ${label} ledger: stock ${ledger.stock} + sales ${ledger.sales} > initial ${world.groupbuy.initialStock}`,
      );
    }
    if (ledger.stock < 0 || ledger.sales < 0) {
      broken.push(`INV5 group-buy ${label} ledger went negative (${ledger.stock}/${ledger.sales})`);
    }
  }

  // --- 6. the effects ledger has no duplicate (aggregate, event) ------------
  const effectRows = await db
    .select({
      scope: effectsTable.scope,
      scopeId: effectsTable.scopeId,
      eventType: effectsTable.eventType,
    })
    .from(effectsTable);
  const seen = new Set<string>();
  for (const row of effectRows) {
    const key = `${row.scope}/${row.scopeId}/${row.eventType}`;
    if (seen.has(key)) broken.push(`INV6 the effects ledger holds ${key} twice`);
    seen.add(key);
  }

  // --- 7. refunded_quantity is what the refunds count (REFUND-015) ----------
  const refundById = new Map(refundRows.map((row) => [row.id, row]));
  const counted = new Map<number, number>();
  const reserved = new Map<number, number>();
  for (const line of refundItemRows) {
    const refund = refundById.get(line.refundId);
    if (refund === undefined || !countsUnits(refund.kind, refund.status)) continue;
    counted.set(line.orderItemId, (counted.get(line.orderItemId) ?? 0) + line.quantity);
    if (refund.isAutomatic || world.reservedUnshipped.has(refund.id)) {
      reserved.set(line.orderItemId, (reserved.get(line.orderItemId) ?? 0) + line.quantity);
    }
  }
  for (const item of itemRows) {
    const expected = counted.get(item.id) ?? 0;
    if (item.refundedQuantity !== expected) {
      broken.push(
        `INV7 line ${item.id}: refunded_quantity ${item.refundedQuantity} but its refunds count ${expected}`,
      );
    }
    // --- 8. a unit is shipped or refunded before shipping, never both -------
    const taken = reserved.get(item.id) ?? 0;
    if (item.shippedQuantity + taken > item.quantity) {
      broken.push(
        `INV8 line ${item.id}: ${item.shippedQuantity} shipped + ${taken} refunded before shipping > ${item.quantity}`,
      );
    }
  }

  return broken;
}

// ---------------------------------------------------------------------------
// the driver
// ---------------------------------------------------------------------------

async function runSequence(seed: number): Promise<void> {
  const rng = mulberry32(seed);
  const log: string[] = [`seed=0x${seed.toString(16)} steps=${STEPS}`];
  const world = await buildWorld();

  const report = (): string => log.join('\n');

  const opening = await checkInvariants(world);
  if (opening.length > 0) {
    throw new Error(`SEQ-001 broke before the first step:\n${opening.join('\n')}\n\n${report()}`);
  }

  for (let step = 1; step <= STEPS; step += 1) {
    const name = pick(rng, STEP_NAMES);
    currentStatuses = await statuses(world);
    currentRefunds = await refundStates(world);
    let outcome: string;
    try {
      outcome = await STEPS_BY_NAME[name](world, rng);
    } catch (error) {
      if (!DomainError.is(error)) {
        // Anything that is not a DomainError is a 500 on a real server. The
        // sequence stops here and hands over the seed and the whole log.
        log.push(`${String(step).padStart(3)} ${name} THREW ${String(error)}`);
        throw new Error(
          `SEQ-001 seed 0x${seed.toString(16)} step ${step} (${name}) threw a non-DomainError: ${String(error)}\n\n${report()}`,
          { cause: error },
        );
      }
      outcome = `${name} refused: ${error.code}`;
    }
    log.push(`${String(step).padStart(3)} ${outcome}`);

    const broken = await checkInvariants(world);
    if (broken.length > 0) {
      throw new Error(
        `SEQ-001 seed 0x${seed.toString(16)} broke after step ${step} (${name}):\n` +
          `${broken.join('\n')}\n\n${report()}`,
      );
    }
  }

  // The worker catches up: whatever the ledger still holds is delivered, and
  // the eight properties must survive that too.
  const drained = await drainEffects(harness.ctx, { baseBackoffMs: 0, maxBackoffMs: 0 });
  log.push(`drain ${JSON.stringify(drained)}`);
  const settled = await checkInvariants(world);
  if (settled.length > 0) {
    throw new Error(
      `SEQ-001 seed 0x${seed.toString(16)} broke after the final drain:\n` +
        `${settled.join('\n')}\n\n${report()}`,
    );
  }

  // A sequence that refused everything would pass all eight invariants and prove
  // nothing, so the run has to have moved money at least once.
  const paid = await harness.ctx.db.select().from(paymentAttempts);
  expect(
    paid.some((attempt) => attempt.status === 'paid'),
    `seed 0x${seed.toString(16)} never booked a payment — the sequence did nothing:\n${report()}`,
  ).toBe(true);
}

describe('SEQ-001 — a fixed-seed interleaving of real operations', () => {
  // A loop with a template title rather than `it.each`, so `pnpm guards` can
  // read the title the ledger cites (`… seed <seed>`).
  for (const seed of seeds) {
    it(`holds every invariant after every step, seed 0x${seed.toString(16)}`, async () => {
      await runSequence(seed);
    }, 300_000);
  }
});

/**
 * Found by the sequence above. `StockPort.commit` (catalog.stock.ts, the one
 * place that increments `product_skus.sales`) is reached only through the
 * `onOrderPaid` hook; without it `sales` stays 0 however much is paid, and the
 * refund path's `greatest(0, sales - n)` hides the drift.
 */
describe('a paid order is counted as sold', () => {
  it('moves the SKU from reserved to sold when the payment is booked', async () => {
    const world = await buildWorld();
    const shopper = world.shoppers[0]!;
    const intent = await startPayment(as(shopper.userId), {
      orderId: shopper.orderId,
      channel: 'wechat_mini',
      openid: `oFake${shopper.userId}`,
    });
    gateway.markPaid(intent.outTradeNo);
    const ack = await handleTransactionNotify(
      harness.ctx,
      gateway.signTransactionNotification({ outTradeNo: intent.outTradeNo }),
    );
    expect(ack.status).toBe(200);
    await drainEffects(harness.ctx, { baseBackoffMs: 0, maxBackoffMs: 0 });

    const [sku] = await harness.ctx.db
      .select({ stock: productSkus.stock, sales: productSkus.sales })
      .from(productSkus)
      .where(eq(productSkus.id, shopper.skuId));
    const [product] = await harness.ctx.db
      .select({ sales: products.sales })
      .from(products)
      .where(eq(products.id, shopper.productId));
    expect(sku).toEqual({ stock: 8, sales: 2 });
    expect(product?.sales).toBe(2);
  });

  // The paid hook commits every kind of order, a presale one included, and
  // `presale:commit-sale` moves only the campaign's own ledger. So the SKU's
  // `sales` goes up once per order — and a second commit for the same order,
  // however it arrives, is a no-op by the port's `catalog.stock.commit` key.
  it('commits a presale order once, however often the sale is committed again', async () => {
    const world = await buildWorld();
    const buyer = await makeUser('seq-ps');
    const detail = await order.create(as(buyer), {
      source: 'buy-now',
      cartItemIds: [],
      item: { skuId: String(world.presale.skuId), quantity: 2 },
      kind: 'presale',
      kindMeta: { activityId: String(world.presale.activityId) },
      idempotencyKey: 'seq-ps-0000000001',
    });
    const orderId = Number(detail.id);
    const intent = await startPayment(as(buyer), {
      orderId,
      channel: 'wechat_mini',
      openid: `oFake${buyer}`,
    });
    gateway.markPaid(intent.outTradeNo);
    const ack = await handleTransactionNotify(
      harness.ctx,
      gateway.signTransactionNotification({ outTradeNo: intent.outTradeNo }),
    );
    expect(ack.status).toBe(200);

    const skuSales = async () =>
      (
        await harness.ctx.db
          .select({ stock: productSkus.stock, sales: productSkus.sales })
          .from(productSkus)
          .where(eq(productSkus.id, world.presale.skuId))
      )[0];
    const campaignSales = async () =>
      (
        await harness.ctx.db
          .select({ sales: presaleActivitySkus.sales })
          .from(presaleActivitySkus)
          .where(eq(presaleActivitySkus.activityId, world.presale.activityId))
      )[0]?.sales;
    expect(onOrderPaid.names().filter((name) => name.endsWith(':commit-sale'))).toEqual(
      expect.arrayContaining([COMMIT_SALE_HOOK, 'presale:commit-sale']),
    );
    expect(await skuSales()).toEqual({ stock: 198, sales: 2 });
    expect(await campaignSales()).toBe(2);

    // Replay the sale: the port directly, then every paid hook as a whole.
    await harness.ctx.withTx(async (tx) => {
      await resolveStockPort().commit(tx, orderId, [{ skuId: world.presale.skuId, quantity: 2 }]);
      await onOrderPaid.dispatch(tx, harness.ctx, {
        orderId,
        orderNo: detail.orderNo,
        userId: buyer,
        at: harness.clock.now(),
        paidAmount: Money.parse(detail.payableAmount),
      });
    });
    expect(await skuSales()).toEqual({ stock: 198, sales: 2 });
    expect(await campaignSales()).toBe(2);
  });
});

/**
 * Found by the sequence's final drain. `payment.service.ts` records an
 * `('order', id, 'order.paid')` effect in every paid transaction and
 * `refund.service.ts` an `('order', id, 'order.refunded')` one in every settled
 * refund. With no handler for either, the dispatcher would retry each one eight
 * times ("no handler for order/order.paid") and park it as `unknown` — one row
 * in 待处理 and one error log per paid order, forever.
 */
describe('every effect a paid and refunded order records is delivered', () => {
  it('leaves nothing parked for want of a handler', async () => {
    const world = await buildWorld();
    const shopper = world.shoppers[0]!;
    const intent = await startPayment(as(shopper.userId), {
      orderId: shopper.orderId,
      channel: 'wechat_mini',
      openid: `oFake${shopper.userId}`,
    });
    gateway.markPaid(intent.outTradeNo);
    await handleTransactionNotify(
      harness.ctx,
      gateway.signTransactionNotification({ outTradeNo: intent.outTradeNo }),
    );

    const [item] = await harness.ctx.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, shopper.orderId));
    const refund = await refundService.apply(as(shopper.userId), {
      orderId: String(shopper.orderId),
      kind: 'refund_only',
      lines: [{ orderItemId: String(item!.id), quantity: 2 }],
      reason: '不想要了',
      images: [],
      includeFreight: false,
    });
    await refundAdmin.adminApprove(asAdmin(world.adminId), { id: refund.id });
    await drainEffects(harness.ctx, { baseBackoffMs: 0, maxBackoffMs: 0 });
    const [row] = await harness.ctx.db
      .select()
      .from(refunds)
      .where(eq(refunds.id, Number(refund.id)));
    gateway.markRefunded(row!.outRefundNo!, 'SUCCESS');
    await refundService.handleRefundNotify(
      harness.ctx,
      gateway.signRefundNotification({ outRefundNo: row!.outRefundNo! }),
    );
    expect((await harness.ctx.db.select().from(refunds))[0]!.status).toBe('succeeded');

    await drainEffects(harness.ctx, { baseBackoffMs: 0, maxBackoffMs: 0 });
    const parked = await harness.ctx.db
      .select({ eventType: effectsTable.eventType, lastError: effectsTable.lastError })
      .from(effectsTable)
      .where(eq(effectsTable.status, 'unknown'));
    expect(parked).toEqual([]);
  });
});
