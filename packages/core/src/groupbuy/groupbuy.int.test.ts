import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { products, productSkus } from '@shop/db/schema/catalog';
import { notificationMessages, notificationTemplates } from '@shop/db/schema/notification';
import { configValues, effects } from '@shop/db/schema/system';
import { wechatIdentities } from '@shop/db/schema/wechat';
import {
  groupbuyActivities,
  groupbuyActivitySkus,
  groupbuyGroups,
  groupbuyMembers,
} from '@shop/db/schema/groupbuy';
import { orderItems, orders } from '@shop/db/schema/order';
import { refunds } from '@shop/db/schema/refund';
import { userAddresses, users } from '@shop/db/schema/user';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { startFakeOaServer, type FakeOaServer } from '@shop/testing/wechat';
import { registerCatalogDomain } from '../catalog';
import { getEffectHandler } from '../effects/index';
import { notificationAdmin, registerSmsPort, type SmsPort } from '../notification';
import { resetWechatTokenFlight, wechatConfig } from '../wechat';
import { registerShippingFreightPort, templates as shippingTemplates } from '../shipping';
import { anonymousActor, type Actor, type Ctx } from '../kernel/context';
import { Money } from '../kernel/money';
import { withTx } from '../kernel/tx';
import * as checkout from '../order';
import {
  onOrderCancelled,
  onOrderPaid,
  onOrderRefunded,
  registerOrderStateMachine,
  resetOrderPorts,
} from '../order/ports';
import { groupbuyConfig } from './groupbuy.config';
import { clearAutoRefundPort, registerAutoRefundPort } from './groupbuy.effects';
import { closeEndedActivities, settleExpiredGroups, settleGroup } from './groupbuy.jobs';
import { groupbuyKindHandler } from './groupbuy.order';
import * as repo from './groupbuy.repo';
import * as service from './groupbuy.service';
import { registerGroupbuyDomain } from './index';

/**
 * The group-buy domain against a real PostgreSQL 17.
 *
 * Everything that matters here is a row count or a CHECK constraint, so none of
 * it can be proved with a fake. The races live next door in
 * `groupbuy.concurrency.int.test.ts`; this file proves the *shapes*: what a
 * paid order does to a team, what a cancel and a refund put back, and that a
 * failed team never loses a shopper's money silently.
 *
 * Orders are written directly rather than through the real checkout. This
 * domain attaches to the order aggregate through `order/ports.ts`, and driving
 * the whole checkout here would be testing the order domain.
 */

let harness: TestCtx;

const NOW = '2026-06-01T00:00:00.000Z';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  // `truncateAll` empties the settings table but not the config cache, and a
  // test that stores config would otherwise leak it into the next one.
  await harness.ctx.config.invalidate(groupbuyConfig.group);
  // The 人气条 is cached in Redis for a minute; without this a test reads the
  // previous test's count.
  await harness.redis.flushdb();
  harness.clock.set(NOW);
  resetOrderPorts();
  clearAutoRefundPort();
  registerGroupbuyDomain();
});

afterEach(() => {
  resetOrderPorts();
  clearAutoRefundPort();
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const userActor = (id: number): Actor => ({ kind: 'user', id, permissions: [], isSuper: false });
const asUser = (id: number): Ctx => harness.as(userActor(id));
const asAdmin = (permissions: string[]): Ctx =>
  harness.as({ kind: 'admin', id: 1, permissions, isSuper: false });

let sequence = 0;

async function makeUser(nickname?: string): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({
      account: `gb-u-${sequence}`,
      nickname: nickname ?? `顾客${sequence}`,
      avatarUrl: `https://example.test/u/${sequence}.png`,
    })
    .returning({ id: users.id });
  return row!.id;
}

interface ActivityFixture {
  activityId: number;
  productId: number;
  skuId: number;
  seatsRequired: number;
  ttlSeconds: number;
}

async function makeActivity(
  over: {
    seatsRequired?: number;
    ttlSeconds?: number;
    stock?: number;
    totalQuota?: number | null;
    perOrderQuantity?: number;
    price?: string;
    status?: 'draft' | 'active' | 'paused' | 'ended';
    endAt?: Date;
  } = {},
): Promise<ActivityFixture> {
  sequence += 1;
  const stock = over.stock ?? 100;
  const price = over.price ?? '59.00';

  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `坚果礼盒${sequence}`,
      imageUrl: 'https://example.test/p.png',
      // On the shelf so the price tests below can buy it through the real
      // checkout; the rest of this file writes its orders directly.
      status: 'on_shelf',
      // `products_freight_source` insists a `template` product names a template.
      freightMode: 'free',
      price: '88.00',
      stock: 1_000,
    })
    .returning({ id: products.id });
  const [sku] = await harness.ctx.db
    .insert(productSkus)
    .values({
      productId: product!.id,
      skuCode: `SKU-${sequence}`,
      specText: '混合装|1000g',
      specValues: { 规格: '混合装' },
      price: '88.00',
      originalPrice: '108.00',
      stock: 1_000,
    })
    .returning({ id: productSkus.id });

  const seatsRequired = over.seatsRequired ?? 3;
  const ttlSeconds = over.ttlSeconds ?? 86_400;
  const [activity] = await harness.ctx.db
    .insert(groupbuyActivities)
    .values({
      productId: product!.id,
      title: `${seatsRequired}人成团${sequence}`,
      imageUrl: 'https://example.test/p.png',
      status: over.status ?? 'active',
      price,
      originalPrice: '88.00',
      seatsRequired,
      groupTtlSeconds: ttlSeconds,
      stock,
      totalQuota: over.totalQuota === undefined ? null : over.totalQuota,
      perOrderQuantity: over.perOrderQuantity ?? 2,
      startAt: new Date('2026-05-01T00:00:00.000Z'),
      endAt: over.endAt ?? new Date('2026-07-01T00:00:00.000Z'),
    })
    .returning({ id: groupbuyActivities.id });

  await harness.ctx.db.insert(groupbuyActivitySkus).values({
    activityId: activity!.id,
    skuId: sku!.id,
    price,
    stock,
    quota: over.totalQuota === undefined ? null : over.totalQuota,
    isEnabled: true,
  });

  return {
    activityId: activity!.id,
    productId: product!.id,
    skuId: sku!.id,
    seatsRequired,
    ttlSeconds,
  };
}

async function makeOrder(args: {
  userId: number;
  fixture: ActivityFixture;
  quantity?: number;
  amount?: string;
}): Promise<{ orderId: number; orderNo: string }> {
  sequence += 1;
  const quantity = args.quantity ?? 1;
  const amount = args.amount ?? '59.00';
  const orderNo = `GB${String(sequence).padStart(10, '0')}`;
  const [order] = await harness.ctx.db
    .insert(orders)
    .values({
      orderNo,
      userId: args.userId,
      platform: 'h5',
      kind: 'groupbuy',
      status: 'pending_payment',
      totalQuantity: quantity,
      itemsAmount: amount,
      payableAmount: amount,
      receiverName: '张三',
      receiverPhone: '13800000000',
      receiverProvince: '广东省',
      receiverCity: '深圳市',
      receiverDetail: '某路 1 号',
    })
    .returning({ id: orders.id });
  await harness.ctx.db.insert(orderItems).values({
    orderId: order!.id,
    productId: args.fixture.productId,
    skuId: args.fixture.skuId,
    itemKey: `line-${sequence}`,
    quantity,
    unitPrice: amount,
    totalAmount: amount,
    snapshot: { name: '坚果礼盒', productKind: 'physical' } as never,
  });
  return { orderId: order!.id, orderNo };
}

/**
 * The whole "place a group-buy order" path as the checkout drives it: the kind
 * handler's two halves inside one transaction.
 */
async function placeOrder(args: {
  userId: number;
  fixture: ActivityFixture;
  groupId?: number;
  quantity?: number;
  amount?: string;
}): Promise<{ orderId: number; groupId: number }> {
  const order = await makeOrder(args);
  const ctx = asUser(args.userId);
  await withTx(harness.ctx.db, async (tx) => {
    const meta = await groupbuyKindHandler.beforeCreate(ctx, tx, {
      userId: args.userId,
      lines: [
        {
          skuId: args.fixture.skuId,
          productId: args.fixture.productId,
          quantity: args.quantity ?? 1,
          unitPrice: Money.parse(args.amount ?? '59.00'),
          subtotal: Money.parse(args.amount ?? '59.00'),
        },
      ],
      goodsTotal: Money.parse(args.amount ?? '59.00'),
      selections: {
        kind: 'groupbuy',
        activityId: String(args.fixture.activityId),
        ...(args.groupId ? { groupId: String(args.groupId) } : {}),
      },
    });
    await groupbuyKindHandler.afterCreate(ctx, tx, order.orderId, meta);
  });
  const member = await repo.findMemberByOrder(harness.ctx.db, order.orderId);
  return { orderId: order.orderId, groupId: member!.groupId };
}

/** Marks the order paid and fires the hook, the way the payment callback does. */
async function pay(orderId: number): Promise<void> {
  const at = harness.clock.now();
  await withTx(harness.ctx.db, async (tx) => {
    await tx
      .update(orders)
      .set({ status: 'paid', paidAt: at, paidAmount: '59.00' })
      .where(eq(orders.id, orderId));
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    await onOrderPaid.dispatch(tx, harness.ctx, {
      orderId,
      orderNo: order!.orderNo,
      userId: order!.userId,
      at,
      paidAmount: Money.parse('59.00'),
    });
  });
}

async function cancel(orderId: number): Promise<void> {
  const at = harness.clock.now();
  await withTx(harness.ctx.db, async (tx) => {
    // `orders_cancelled_shape` insists the two move together.
    await tx
      .update(orders)
      .set({ status: 'cancelled', cancelledAt: at })
      .where(eq(orders.id, orderId));
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    await onOrderCancelled.dispatch(tx, harness.ctx, {
      orderId,
      orderNo: order!.orderNo,
      userId: order!.userId,
      at,
      reason: 'timeout',
    });
  });
}

async function refund(orderId: number, partial = false): Promise<void> {
  const at = harness.clock.now();
  await withTx(harness.ctx.db, async (tx) => {
    if (!partial) await tx.update(orders).set({ status: 'refunded' }).where(eq(orders.id, orderId));
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    await onOrderRefunded.dispatch(tx, harness.ctx, {
      orderId,
      orderNo: order!.orderNo,
      userId: order!.userId,
      at,
      refundId: 1,
      refundedAmount: Money.parse('59.00'),
      partial,
    });
  });
}

async function readGroup(groupId: number) {
  const [row] = await harness.ctx.db
    .select()
    .from(groupbuyGroups)
    .where(eq(groupbuyGroups.id, groupId));
  return row!;
}

async function readActivityCounters(fixture: ActivityFixture) {
  const [activity] = await harness.ctx.db
    .select({ stock: groupbuyActivities.stock, sales: groupbuyActivities.sales })
    .from(groupbuyActivities)
    .where(eq(groupbuyActivities.id, fixture.activityId));
  const [sku] = await harness.ctx.db
    .select({ stock: groupbuyActivitySkus.stock, sales: groupbuyActivitySkus.sales })
    .from(groupbuyActivitySkus)
    .where(eq(groupbuyActivitySkus.activityId, fixture.activityId));
  return { activity: activity!, sku: sku! };
}

async function effectsFor(orderId: number, eventType: string) {
  return harness.ctx.db
    .select()
    .from(effects)
    .where(eq(effects.scopeId, String(orderId)))
    .then((rows) => rows.filter((row) => row.eventType === eventType));
}

// ---------------------------------------------------------------------------

/**
 * `buildDraft` passes `kind` and every `kindMeta` key into the pricing
 * `selections`, so the contributor sees which activity the shopper picked and
 * the 拼团价 reaches the order by itself.
 *
 * These are the only tests in this file that drive the real checkout. They have
 * to: the whole point is that the price travels from the activity table through
 * `preview`/`create` without this domain writing the number itself.
 */
describe('the group-buy price through the real checkout', () => {
  beforeEach(() => {
    // The catalogue port `buildDraft` reads SKUs through, the freight port it
    // quotes with, and the state machine its inserts are validated against.
    registerCatalogDomain();
    registerShippingFreightPort();
    registerOrderStateMachine(checkout.orderStateMachine);
  });

  async function shopper(): Promise<{ userId: number; ctx: Ctx }> {
    const userId = await makeUser();
    await harness.ctx.db.insert(userAddresses).values({
      userId,
      receiverName: '张三',
      receiverPhone: '13800138000',
      provinceName: '浙江省',
      cityName: '杭州市',
      districtName: '西湖区',
      detail: '文三路 100 号',
      isDefault: true,
    });
    return { userId, ctx: asUser(userId) };
  }

  const buyNow = (
    fixture: ActivityFixture,
    kindMeta?: { activityId: string; groupId?: string },
  ) => ({
    source: 'buy-now' as const,
    cartItemIds: [],
    item: { skuId: String(fixture.skuId), quantity: 1 },
    ...(kindMeta === undefined
      ? { kind: 'normal' as const }
      : { kind: 'groupbuy' as const, kindMeta }),
  });

  it('prices a group-buy order at the activity price, preview and create', async () => {
    const fixture = await makeActivity();
    const { userId, ctx } = await shopper();
    const meta = { activityId: String(fixture.activityId) };

    const preview = await checkout.preview(ctx, buyNow(fixture, meta));
    // 88.00 in the catalogue, 59.00 in the activity. The checkout books the
    // difference as an adjustment rather than rewriting the unit price, so
    // `itemsAmount` stays the catalogue total and the shopper is shown where
    // the 29.00 went.
    expect(preview.itemsAmount).toBe('88.00');
    expect(preview.payableAmount).toBe('59.00');
    expect(preview.lines[0]?.totalAmount).toBe('59.00');
    expect(preview.adjustments.map((row) => row.amount)).toEqual(['-29.00']);
    expect(preview.adjustments[0]?.label).toContain('拼团价');

    const created = await checkout.create(ctx, {
      ...buyNow(fixture, meta),
      idempotencyKey: `gb-${fixture.activityId}`,
    });
    expect(created.payableAmount).toBe('59.00');
    expect(created.kind).toBe('groupbuy');

    // …and the order really is in a team, at that price.
    const [line] = await harness.ctx.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, Number(created.id)));
    expect(line!.totalAmount).toBe('59.00');
    const member = await repo.findMemberByOrder(harness.ctx.db, Number(created.id));
    expect(member).toMatchObject({ userId, role: 'leader', status: 'joined' });
    expect((await readGroup(member!.groupId)).activityId).toBe(fixture.activityId);
  });

  it('ORDER-011 — the order detail names the team an order opened or joined, and nothing for an ordinary order', async () => {
    const fixture = await makeActivity();
    const leader = await shopper();
    const opened = await checkout.create(leader.ctx, {
      ...buyNow(fixture, { activityId: String(fixture.activityId) }),
      idempotencyKey: `open-${fixture.activityId}`,
    });
    const team = await repo.findMemberByOrder(harness.ctx.db, Number(opened.id));
    // 开团: the team exists with the unpaid order, so the link is there from the start.
    expect(opened.groupbuyTeamId).toBe(String(team!.groupId));
    // 拼团中, and the leader's own seat — the list says the same as the detail.
    expect(opened.groupbuyTeam).toMatchObject({
      id: String(team!.groupId),
      status: 'forming',
      role: 'leader',
    });
    const listed = await checkout.list(leader.ctx, {
      tab: 'all',
      page: 1,
      pageSize: 20,
      sortOrder: 'desc',
    });
    expect(listed.items.find((o) => o.id === opened.id)?.groupbuyTeam?.status).toBe('forming');
    await pay(Number(opened.id));

    const joiner = await shopper();
    const joined = await checkout.create(joiner.ctx, {
      ...buyNow(fixture, {
        activityId: String(fixture.activityId),
        groupId: String(team!.groupId),
      }),
      idempotencyKey: `join-${fixture.activityId}`,
    });
    const read = await checkout.detail(joiner.ctx, { id: joined.id });
    expect(read.groupbuyTeamId).toBe(String(team!.groupId));
    expect(read.groupbuyTeam).toMatchObject({ id: String(team!.groupId), role: 'member' });

    // A cancelled join keeps the link: the team page shows how it went on without them.
    await cancel(Number(joined.id));
    expect((await checkout.detail(joiner.ctx, { id: joined.id })).groupbuyTeamId).toBe(
      String(team!.groupId),
    );

    const ordinary = await checkout.create(joiner.ctx, {
      ...buyNow(fixture),
      idempotencyKey: `plain-${fixture.activityId}`,
    });
    expect(ordinary.groupbuyTeamId).toBeNull();
    expect(ordinary.groupbuyTeam).toBeNull();
  });

  it('RISK-D-013 — 取消拼团 closes the leader’s unpaid order with the team', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const leader = await shopper();
    const opened = await checkout.create(leader.ctx, {
      ...buyNow(fixture, { activityId: String(fixture.activityId) }),
      idempotencyKey: `withdraw-${fixture.activityId}`,
    });
    const team = await repo.findMemberByOrder(harness.ctx.db, Number(opened.id));

    const view = await service.withdraw(leader.ctx, { id: String(team!.groupId) });
    expect(view.status).toBe('cancelled');

    const after = await checkout.detail(leader.ctx, { id: opened.id });
    expect(after.status).toBe('cancelled');
    expect(after.groupbuyTeam).toMatchObject({ status: 'cancelled' });
    // The activity stock the unpaid order held is back.
    expect((await readActivityCounters(fixture)).activity).toEqual({ stock: 10, sales: 0 });
  });

  it('ORDER-013 — an activity that closed after the preview answers 活动未开放, not 价格有变动', async () => {
    const fixture = await makeActivity();
    const { ctx } = await shopper();
    const meta = { activityId: String(fixture.activityId) };
    const preview = await checkout.preview(ctx, buyNow(fixture, meta));
    expect(preview.payableAmount).toBe('59.00');

    // The activity closes between the preview and the submit.
    await harness.ctx.db
      .update(groupbuyActivities)
      .set({ status: 'ended' })
      .where(eq(groupbuyActivities.id, fixture.activityId));

    await expect(
      checkout.create(ctx, {
        ...buyNow(fixture, meta),
        idempotencyKey: `ended-${fixture.activityId}`,
        expectedPayableAmount: preview.payableAmount,
      }),
    ).rejects.toMatchObject({ code: 'GROUPBUY_ACTIVITY_NOT_OPEN' });
  });

  it('charges freight by the activity’s 运费模板, not the product’s 包邮', async () => {
    const fixture = await makeActivity();
    // ¥6 for the first piece, anywhere.
    const template = await shippingTemplates.create(harness.ctx, {
      name: '活动运费',
      chargeMode: 'quantity',
      hasFreeRules: false,
      hasNoDeliveryRules: false,
      sortOrder: 0,
      regions: [
        {
          isFallback: true,
          cityIds: [],
          firstUnit: 1,
          firstPrice: '6.00',
          additionalUnit: 1,
          additionalPrice: '2.00',
        },
      ],
      freeRules: [],
      noDeliveryCityIds: [],
    });
    await harness.ctx.db
      .update(groupbuyActivities)
      .set({ shippingTemplateId: Number(template.id) })
      .where(eq(groupbuyActivities.id, fixture.activityId));
    const { ctx } = await shopper();

    const onActivity = await checkout.preview(
      ctx,
      buyNow(fixture, { activityId: String(fixture.activityId) }),
    );
    expect(onActivity.freightAmount).toBe('6.00');
    expect(onActivity.payableAmount).toBe('65.00');
    // The product itself is still 包邮 outside the activity.
    expect((await checkout.preview(ctx, buyNow(fixture))).freightAmount).toBe('0.00');
  });

  it('leaves the same SKU at its ordinary price on an ordinary order', async () => {
    const fixture = await makeActivity();
    const { ctx } = await shopper();

    const preview = await checkout.preview(ctx, buyNow(fixture));
    expect(preview.itemsAmount).toBe('88.00');
    expect(preview.payableAmount).toBe('88.00');
    expect(preview.adjustments).toEqual([]);

    const created = await checkout.create(ctx, {
      ...buyNow(fixture),
      idempotencyKey: `normal-${fixture.activityId}`,
    });
    expect(created.payableAmount).toBe('88.00');
    expect(created.kind).toBe('normal');
    expect(await repo.findMemberByOrder(harness.ctx.db, Number(created.id))).toBeNull();
  });

  it('ORDER-009 — a kind smuggled into kindMeta never reprices an ordinary order', async () => {
    // The contract strips it; this is the service's own half, for a caller
    // that reaches `preview` without the contract. `kind` is written after
    // the kind's payload, so `{ kind: 'groupbuy' }` inside it cannot turn the
    // activity price on for an order that joins no team.
    const fixture = await makeActivity();
    const { ctx } = await shopper();
    const smuggled = {
      ...buyNow(fixture),
      kindMeta: { kind: 'groupbuy', activityId: String(fixture.activityId) },
    } as unknown as Parameters<typeof checkout.preview>[1];

    const preview = await checkout.preview(ctx, smuggled);
    expect(preview.payableAmount).toBe('88.00');
    expect(preview.adjustments).toEqual([]);
  });

  it('prices a shopper joining an open team the same way', async () => {
    const fixture = await makeActivity();
    const leaderId = await makeUser();
    const leader = await placeOrder({ userId: leaderId, fixture });
    await pay(leader.orderId);

    const { ctx } = await shopper();
    const meta = { activityId: String(fixture.activityId), groupId: String(leader.groupId) };
    const created = await checkout.create(ctx, {
      ...buyNow(fixture, meta),
      idempotencyKey: `join-${fixture.activityId}`,
    });

    expect(created.payableAmount).toBe('59.00');
    const member = await repo.findMemberByOrder(harness.ctx.db, Number(created.id));
    expect(member?.groupId).toBe(leader.groupId);
  });
});

describe('beforeCreate', () => {
  it('refuses an order whose draft is not at the activity price', async () => {
    const fixture = await makeActivity();
    const userId = await makeUser();
    // 88.00 is the catalogue price. A real checkout cannot produce it for a
    // `groupbuy` order, which is exactly why this guard matters: it is what
    // would catch the contributor being dropped, reordered or silently
    // returning `[]`.
    await expect(placeOrder({ userId, fixture, amount: '88.00' })).rejects.toMatchObject({
      code: 'GROUPBUY_PRICE_NOT_APPLIED',
    });
  });

  it('refuses a closed activity, an over-large quantity and a foreign SKU', async () => {
    const paused = await makeActivity({ status: 'paused' });
    const userId = await makeUser();
    await expect(placeOrder({ userId, fixture: paused })).rejects.toMatchObject({
      code: 'GROUPBUY_ACTIVITY_NOT_OPEN',
    });

    const capped = await makeActivity({ perOrderQuantity: 1 });
    await expect(
      placeOrder({ userId, fixture: capped, quantity: 2, amount: '118.00' }),
    ).rejects.toMatchObject({ code: 'GROUPBUY_QUANTITY_NOT_ALLOWED' });

    const other = await makeActivity();
    await expect(
      placeOrder({ userId, fixture: { ...capped, skuId: other.skuId } }),
    ).rejects.toMatchObject({ code: 'GROUPBUY_SKU_NOT_IN_ACTIVITY' });
  });

  it('refuses joining a team the shopper is already in', async () => {
    const fixture = await makeActivity();
    const leader = await makeUser();
    const { groupId } = await placeOrder({ userId: leader, fixture });
    await expect(placeOrder({ userId: leader, fixture, groupId })).rejects.toMatchObject({
      code: 'GROUPBUY_ALREADY_IN_GROUP',
    });
  });
});

describe('placing an order', () => {
  it('opens a team with no seat taken and holds the activity stock', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const leader = await makeUser('小明');
    const { groupId } = await placeOrder({ userId: leader, fixture });

    const group = await readGroup(groupId);
    expect(group.status).toBe('forming');
    // The seat waits for the money. A `forming` team with `seats_taken: 0` is
    // a team whose leader has not paid yet.
    expect(group.seatsTaken).toBe(0);
    expect(group.leaderUserId).toBe(leader);
    expect(group.expiresAt.toISOString()).toBe('2026-06-02T00:00:00.000Z');

    const counters = await readActivityCounters(fixture);
    expect(counters.activity).toEqual({ stock: 9, sales: 0 });
    expect(counters.sku).toEqual({ stock: 9, sales: 0 });

    // Identity is frozen onto the row, so a later rename cannot rewrite the card.
    const member = await repo.findMemberByOrder(
      harness.ctx.db,
      (await allMembers(groupId))[0]!.orderId,
    );
    expect(member).toMatchObject({ role: 'leader', status: 'joined', nickname: '小明' });
  });

  it('starts the team clock in the same transaction, as a delayed effect', async () => {
    const fixture = await makeActivity({ stock: 10, ttlSeconds: 3_600 });
    const leader = await makeUser();
    const { groupId } = await placeOrder({ userId: leader, fixture });

    // A queue is not transactional; the effects ledger is. The timer therefore
    // exists exactly when the team does, and never without it.
    const [timer] = await harness.ctx.db
      .select()
      .from(effects)
      .where(eq(effects.scopeId, String(groupId)));
    expect(timer).toMatchObject({ scope: 'groupbuy', eventType: 'groupbuy.expire' });
    expect(timer!.nextRunAt.toISOString()).toBe('2026-06-01T01:00:00.000Z');

    // And when it fires, the team settles exactly as the sweep would.
    harness.clock.set('2026-06-01T02:00:00.000Z');
    const handler = await import('../effects/index').then((m) =>
      m.getEffectHandler('groupbuy', 'groupbuy.expire'),
    );
    await handler!(harness.ctx, {
      id: timer!.id,
      scope: timer!.scope,
      scopeId: timer!.scopeId,
      eventType: timer!.eventType,
      payload: timer!.payload,
      attempts: 1,
    });
    expect(await readGroup(groupId)).toMatchObject({ status: 'cancelled' });
  });

  it('refuses when the activity is out of its own stock, even though the SKU is not', async () => {
    const fixture = await makeActivity({ stock: 1 });
    const first = await makeUser();
    const second = await makeUser();
    await placeOrder({ userId: first, fixture });
    await expect(placeOrder({ userId: second, fixture })).rejects.toMatchObject({
      code: 'GROUPBUY_OUT_OF_STOCK',
    });
  });

  it('enforces the campaign quota in the same statement as the stock', async () => {
    // STOCK-004: `total_quota` is checked in the same `UPDATE`, not a separate
    // SELECT that could be stale by the time it decrements.
    const fixture = await makeActivity({ stock: 10, totalQuota: 1 });
    const first = await makeUser();
    const second = await makeUser();
    const opened = await placeOrder({ userId: first, fixture });
    await pay(opened.orderId);
    await expect(placeOrder({ userId: second, fixture })).rejects.toMatchObject({
      code: 'GROUPBUY_OUT_OF_STOCK',
    });
  });
});

describe('paying', () => {
  it('takes the seat and turns the reservation into a sale', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const leader = await makeUser();
    const { orderId, groupId } = await placeOrder({ userId: leader, fixture });
    await pay(orderId);

    expect(await readGroup(groupId)).toMatchObject({ seatsTaken: 1, status: 'forming' });
    const counters = await readActivityCounters(fixture);
    expect(counters.activity).toEqual({ stock: 9, sales: 1 });
    expect(counters.sku).toEqual({ stock: 9, sales: 1 });
    expect(await effectsFor(orderId, 'groupbuy.join')).toHaveLength(1);
  });

  it('completes the team in the same transaction as the last seat', async () => {
    const fixture = await makeActivity({ seatsRequired: 2, stock: 10 });
    const leader = await makeUser();
    const joiner = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });
    await pay(opened.orderId);
    const joined = await placeOrder({ userId: joiner, fixture, groupId: opened.groupId });
    await pay(joined.orderId);

    const group = await readGroup(opened.groupId);
    expect(group).toMatchObject({ status: 'succeeded', seatsTaken: 2 });
    expect(group.succeededAt).not.toBeNull();
  });

  it('RISK-D-011 — a paid order does not ship while its team is forming, and ships once it succeeded', async () => {
    const fixture = await makeActivity({ seatsRequired: 2, stock: 10 });
    const leader = await makeUser();
    const joiner = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });
    await pay(opened.orderId);
    const admin = asAdmin(['order:shipment:write']);
    const ship = () =>
      checkout.shipOrder(admin, {
        orderId: opened.orderId,
        body: {
          deliveryMode: 'merchant_delivery',
          lines: [],
          courierName: '王五',
          courierPhone: '13900000000',
        },
      });

    await expect(ship()).rejects.toMatchObject({ code: 'ORDER_GROUPBUY_NOT_READY' });
    const listed = await checkout.orderConsole.adminList(admin, adminListQuery());
    expect(listed.items[0]?.groupbuyTeamStatus).toBe('forming');

    const joined = await placeOrder({ userId: joiner, fixture, groupId: opened.groupId });
    await pay(joined.orderId);
    expect(await readGroup(opened.groupId)).toMatchObject({ status: 'succeeded' });
    await expect(ship()).resolves.toMatchObject({ deliveryMode: 'merchant_delivery' });
  });
});

function adminListQuery() {
  return {
    page: 1,
    pageSize: 20,
    sortOrder: 'desc' as const,
    deleted: false,
  } as Parameters<typeof checkout.orderConsole.adminList>[1];
}

describe('cancelling an unpaid order', () => {
  it('gives the activity stock back and leaves no seat behind', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const leader = await makeUser();
    const { orderId, groupId } = await placeOrder({ userId: leader, fixture });
    await cancel(orderId);

    expect(await readActivityCounters(fixture)).toEqual({
      activity: { stock: 10, sales: 0 },
      sku: { stock: 10, sales: 0 },
    });
    // Nobody ever paid into it, so the team is cancelled rather than failed.
    expect(await readGroup(groupId)).toMatchObject({ status: 'cancelled', seatsTaken: 0 });
    const members = await allMembers(groupId);
    expect(members[0]).toMatchObject({ status: 'cancelled' });
    expect(members[0]!.leftAt).not.toBeNull();
  });

  it('hands the team to the next member when the leader walks away', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const leader = await makeUser();
    const joiner = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });
    const joined = await placeOrder({ userId: joiner, fixture, groupId: opened.groupId });

    await cancel(opened.orderId);

    expect(await readGroup(opened.groupId)).toMatchObject({
      status: 'forming',
      leaderUserId: joiner,
    });
    const members = await allMembers(opened.groupId);
    expect(members.find((m) => m.orderId === joined.orderId)).toMatchObject({
      role: 'leader',
      status: 'joined',
    });
    // The outgoing row keeps saying who opened the team — that is the truth,
    // and `groupbuy_members_leader_uq` is partial on `status = 'joined'`, so it
    // does not block the heir.
    expect(members.find((m) => m.orderId === opened.orderId)).toMatchObject({
      role: 'leader',
      status: 'cancelled',
    });
  });
});

describe('refunding a paid order', () => {
  it('returns every activity ledger to where it started', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const leader = await makeUser();
    const { orderId, groupId } = await placeOrder({ userId: leader, fixture });
    await pay(orderId);
    expect(await readActivityCounters(fixture)).toEqual({
      activity: { stock: 9, sales: 1 },
      sku: { stock: 9, sales: 1 },
    });

    await refund(orderId);

    expect(await readActivityCounters(fixture)).toEqual({
      activity: { stock: 10, sales: 0 },
      sku: { stock: 10, sales: 0 },
    });
    // Everybody left a team that had held a seat: failed, not cancelled.
    expect(await readGroup(groupId)).toMatchObject({ status: 'failed', seatsTaken: 0 });
  });

  it('ignores a partial refund — the shopper is still in the team', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const leader = await makeUser();
    const { orderId, groupId } = await placeOrder({ userId: leader, fixture });
    await pay(orderId);
    await refund(orderId, true);

    expect(await readGroup(groupId)).toMatchObject({ status: 'forming', seatsTaken: 1 });
    expect((await allMembers(groupId))[0]).toMatchObject({ status: 'joined' });
  });

  it('keeps a succeeded team full when a member refunds afterwards', async () => {
    const fixture = await makeActivity({ seatsRequired: 2, stock: 10 });
    const leader = await makeUser();
    const joiner = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });
    await pay(opened.orderId);
    const joined = await placeOrder({ userId: joiner, fixture, groupId: opened.groupId });
    await pay(joined.orderId);

    await refund(joined.orderId);

    // `groupbuy_groups_succeeded_is_full` says a completed group is exactly
    // full, and it is true: the team did complete. Freeing the seat would abort
    // the whole transaction on a CHECK violation.
    expect(await readGroup(opened.groupId)).toMatchObject({
      status: 'succeeded',
      seatsTaken: 2,
    });
    expect(await readActivityCounters(fixture)).toEqual({
      activity: { stock: 9, sales: 1 },
      sku: { stock: 9, sales: 1 },
    });
  });

  it('promotes the earliest remaining paid member when the leader refunds', async () => {
    const fixture = await makeActivity({ seatsRequired: 3, stock: 10 });
    const leader = await makeUser();
    const paidMember = await makeUser();
    const unpaidMember = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });
    await pay(opened.orderId);
    const second = await placeOrder({ userId: paidMember, fixture, groupId: opened.groupId });
    await pay(second.orderId);
    // Joins but never pays: not a candidate for leadership.
    await placeOrder({ userId: unpaidMember, fixture, groupId: opened.groupId });

    await refund(opened.orderId);

    expect(await readGroup(opened.groupId)).toMatchObject({
      status: 'forming',
      seatsTaken: 1,
      leaderUserId: paidMember,
    });
  });
});

describe('the expiry sweep', () => {
  it('RISK-D-014 — ends a campaign whose 结束时间 has passed, and leaves a running one alone', async () => {
    // NOW is 2026-06-01.
    const over = await makeActivity({ endAt: new Date('2026-05-31T16:00:00.000Z') });
    const running = await makeActivity();
    const paused = await makeActivity({
      status: 'paused',
      endAt: new Date('2026-05-31T16:00:00.000Z'),
    });

    expect(await closeEndedActivities(harness.ctx)).toEqual({ scanned: 1, closed: 1 });
    const statusOf = async (activityId: number) =>
      (
        await harness.ctx.db
          .select({ status: groupbuyActivities.status })
          .from(groupbuyActivities)
          .where(eq(groupbuyActivities.id, activityId))
      )[0]?.status;
    expect(await statusOf(over.activityId)).toBe('ended');
    expect(await statusOf(running.activityId)).toBe('active');
    expect(await statusOf(paused.activityId)).toBe('paused');
    // A second pass finds nothing left to do.
    expect(await closeEndedActivities(harness.ctx)).toEqual({ scanned: 0, closed: 0 });
  });

  it('fails an under-filled team and asks for one refund per paid member', async () => {
    const fixture = await makeActivity({ seatsRequired: 3, ttlSeconds: 3_600, stock: 10 });
    const leader = await makeUser();
    const joiner = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });
    await pay(opened.orderId);
    const joined = await placeOrder({ userId: joiner, fixture, groupId: opened.groupId });
    await pay(joined.orderId);

    harness.clock.set('2026-06-01T02:00:00.000Z');
    const report = await settleExpiredGroups(harness.ctx);

    expect(report).toMatchObject({ scanned: 1, failed: 1, refunds: 2 });
    expect(await readGroup(opened.groupId)).toMatchObject({ status: 'failed', seatsTaken: 2 });
    expect(await effectsFor(opened.orderId, 'groupbuy.refund')).toHaveLength(1);
    expect(await effectsFor(joined.orderId, 'groupbuy.refund')).toHaveLength(1);
    // The members stay `joined` and the stock stays committed: the ledgers move
    // back when the refund actually lands, through `onOrderRefunded`. Marking
    // them refunded here would claim money had moved when it had not.
    expect(await readActivityCounters(fixture)).toEqual({
      activity: { stock: 8, sales: 2 },
      sku: { stock: 8, sales: 2 },
    });
  });

  it('is idempotent — a second sweep records no second refund', async () => {
    const fixture = await makeActivity({ seatsRequired: 3, ttlSeconds: 3_600, stock: 10 });
    const leader = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });
    await pay(opened.orderId);

    harness.clock.set('2026-06-01T02:00:00.000Z');
    await settleExpiredGroups(harness.ctx);
    const second = await settleExpiredGroups(harness.ctx);

    expect(second.scanned).toBe(0);
    expect(await effectsFor(opened.orderId, 'groupbuy.refund')).toHaveLength(1);
  });

  it('RISK-D-006 — fails and refunds an under-filled team even with the retired 虚拟成团 switch stored as on', async () => {
    const fixture = await makeActivity({ seatsRequired: 3, ttlSeconds: 3_600, stock: 10 });
    const leader = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });
    await pay(opened.orderId);
    await storeRetiredVirtualFill();

    harness.clock.set('2026-06-01T02:00:00.000Z');
    const report = await settleExpiredGroups(harness.ctx);

    expect(report).toMatchObject({ succeeded: 0, failed: 1, refunds: 1 });
    expect(await readGroup(opened.groupId)).toMatchObject({ status: 'failed', seatsTaken: 1 });
    expect(await effectsFor(opened.orderId, 'groupbuy.refund')).toHaveLength(1);
    const detail = await service.adminGroupDetail(asAdmin(['groupbuy:group:read']), {
      id: String(opened.groupId),
    });
    expect(detail.virtuallyFilled).toBe(false);
  });

  it('RISK-D-006 — migration 0004 deletes a stored 虚拟成团 switch', async () => {
    await storeRetiredVirtualFill();
    const sql = readFileSync(
      fileURLToPath(
        new URL('../../../db/migrations/0005_groupbuy_virtual_fill_off.sql', import.meta.url),
      ),
      'utf8',
    );
    await harness.db.handle.pool.query(sql);
    const left = await harness.ctx.db
      .select()
      .from(configValues)
      .where(eq(configValues.group, 'groupbuy'));
    expect(left.map((row) => row.key)).not.toContain('virtualFillOnExpiry');
  });

  it('cancels a team nobody ever paid into', async () => {
    const fixture = await makeActivity({ ttlSeconds: 3_600 });
    const leader = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });

    harness.clock.set('2026-06-01T02:00:00.000Z');
    const report = await settleExpiredGroups(harness.ctx);

    expect(report).toMatchObject({ cancelled: 1, refunds: 0 });
    expect(await readGroup(opened.groupId)).toMatchObject({ status: 'cancelled' });
  });

  it('leaves a team alone while it still has time', async () => {
    const fixture = await makeActivity({ ttlSeconds: 86_400 });
    const leader = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });
    await pay(opened.orderId);

    expect(await settleGroup(harness.ctx, opened.groupId)).toMatchObject({
      outcome: 'unchanged',
    });
  });
});

/**
 * A failed team gives the money back by itself, through
 * `refund.refundSystemInitiated`.
 *
 * What these two prove is the join — that the effect the sweep records reaches
 * the refund domain, and that draining it again does not open a second refund.
 * The refund's own arithmetic (the ceiling, the freight, shipped lines) is
 * proved next door in `refund/refund.system.int.test.ts`.
 */
describe('the system refund for a failed team', () => {
  async function driveRefundEffects(orderIds: number[]): Promise<void> {
    const handler = await import('../effects/index').then((m) =>
      m.getEffectHandler('order', 'groupbuy.refund'),
    );
    for (const orderId of orderIds) {
      for (const row of await effectsFor(orderId, 'groupbuy.refund')) {
        await handler!(harness.ctx, {
          id: row.id,
          scope: row.scope,
          scopeId: row.scopeId,
          eventType: row.eventType,
          payload: row.payload,
          attempts: 1,
        });
      }
    }
  }

  const refundsFor = (orderId: number) =>
    harness.ctx.db.select().from(refunds).where(eq(refunds.orderId, orderId));

  it('gives every paid member exactly one refund, however many sweeps run', async () => {
    const fixture = await makeActivity({ ttlSeconds: 3_600 });
    const leaderId = await makeUser();
    const leader = await placeOrder({ userId: leaderId, fixture });
    await pay(leader.orderId);
    const joinerId = await makeUser();
    const joiner = await placeOrder({ userId: joinerId, fixture, groupId: leader.groupId });
    await pay(joiner.orderId);

    // A member who never paid is owed nothing, and must not get a refund row.
    const ghostId = await makeUser();
    const ghost = await placeOrder({ userId: ghostId, fixture, groupId: leader.groupId });

    harness.clock.set('2026-06-01T02:00:00.000Z');
    // Two sweeps, each drained twice: four chances to refund somebody twice.
    await settleExpiredGroups(harness.ctx);
    await settleExpiredGroups(harness.ctx);
    const orderIds = [leader.orderId, joiner.orderId, ghost.orderId];
    await driveRefundEffects(orderIds);
    await driveRefundEffects(orderIds);

    expect(await refundsFor(ghost.orderId)).toHaveLength(0);
    for (const orderId of [leader.orderId, joiner.orderId]) {
      const rows = await refundsFor(orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'approved',
        isAutomatic: true,
        reason: '拼团未成团，系统自动退款',
        amount: '59.00',
        reviewedByAdminId: null,
      });
      // And the gateway call is queued once, post-commit, like every other.
      const queued = await harness.ctx.db
        .select()
        .from(effects)
        .where(eq(effects.scopeId, String(rows[0]!.id)));
      expect(queued.filter((row) => row.eventType === 'refund.execute')).toHaveLength(1);
    }
  });

  it('lets a test substitute the refund seam', async () => {
    const seen: number[] = [];
    registerAutoRefundPort({
      async refund(_tx, _ctx, input) {
        seen.push(input.orderId);
        return { refundId: 77, created: true };
      },
    });

    const fixture = await makeActivity({ ttlSeconds: 3_600 });
    const leader = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });
    await pay(opened.orderId);
    harness.clock.set('2026-06-01T02:00:00.000Z');
    await settleExpiredGroups(harness.ctx);
    await driveRefundEffects([opened.orderId]);

    expect(seen).toEqual([opened.orderId]);
    expect(await refundsFor(opened.orderId)).toHaveLength(0);
  });
});

describe('the storefront surface', () => {
  it('narrows the list to one product: its live activities only, none for a product with none', async () => {
    const shown = await makeActivity();
    await makeActivity();
    const draft = await makeActivity({ status: 'draft' });

    const forProduct = await service.list(harness.ctx, {
      page: 1,
      pageSize: 20,
      productId: String(shown.productId),
    });
    expect(forProduct.total).toBe(1);
    expect(forProduct.items.map((item) => item.activityId)).toEqual([String(shown.activityId)]);
    expect(forProduct.items[0]?.productId).toBe(String(shown.productId));

    // A product whose only activity is not live is in none, as far as the shopper can tell.
    const hidden = await service.list(harness.ctx, {
      page: 1,
      pageSize: 20,
      productId: String(draft.productId),
    });
    expect(hidden).toMatchObject({ total: 0, items: [] });
  });

  it('answers a manual pick by id, in the given order, with only what the list would show', async () => {
    const first = await makeActivity({ stock: 10 });
    const second = await makeActivity({ stock: 10 });
    const paused = await makeActivity({ stock: 10, status: 'paused' });
    const over = await makeActivity({ stock: 10, endAt: new Date('2026-05-02T00:00:00.000Z') });
    const leader = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture: second });
    await pay(opened.orderId);

    const ids = [second, paused, over, first].map((f) => String(f.activityId));
    const cards = await service.cardsFor(harness.ctx, [...ids, 'x', '0', ids[0]!]);

    expect(cards.map((card) => card.activityId)).toEqual([
      String(second.activityId),
      String(first.activityId),
    ]);
    const listed = await service.list(harness.ctx, { page: 1, pageSize: 20 });
    expect(cards[0]).toEqual(
      listed.items.find((card) => card.activityId === String(second.activityId)),
    );
    expect(cards[0]!.formingGroups).toBe(1);
    expect(await service.cardsFor(harness.ctx, [])).toEqual([]);
  });

  it('finds a picked campaign however many campaigns come before it in the list', async () => {
    const picked = await makeActivity({ stock: 10 });
    await harness.ctx.db
      .update(groupbuyActivities)
      .set({ sortOrder: -1 })
      .where(eq(groupbuyActivities.id, picked.activityId));
    for (let index = 0; index < 3; index += 1) await makeActivity({ stock: 10 });

    const firstPage = await service.list(harness.ctx, { page: 1, pageSize: 3 });
    expect(firstPage.items.map((card) => card.activityId)).not.toContain(String(picked.activityId));
    const cards = await service.cardsFor(harness.ctx, [String(picked.activityId)]);
    expect(cards.map((card) => card.activityId)).toEqual([String(picked.activityId)]);
  });

  it('offers a team only once its leader has paid', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const leader = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });

    const before = await service.openGroups(
      harness.ctx,
      { id: String(fixture.activityId) },
      { page: 1, pageSize: 20 },
    );
    expect(before.items).toHaveLength(0);

    await pay(opened.orderId);
    const after = await service.openGroups(
      harness.ctx,
      { id: String(fixture.activityId) },
      { page: 1, pageSize: 20 },
    );
    expect(after.items).toHaveLength(1);
    expect(after.items[0]).toMatchObject({ seatsTaken: 1, seatsLeft: 2 });
  });

  it('shows paid, unrefunded members only', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const leader = await makeUser('小明');
    const joiner = await makeUser('小红');
    const opened = await placeOrder({ userId: leader, fixture });
    await pay(opened.orderId);
    await placeOrder({ userId: joiner, fixture, groupId: opened.groupId });

    const view = await service.groupDetail(asUser(joiner), { id: String(opened.groupId) });
    expect(view.members.map((m) => m.nickname)).toEqual(['小*']);
    expect(view.me).toMatchObject({ role: 'member', status: 'joined', paid: false });
    expect(view.canJoin).toBe(false);
  });

  it('RISK-D-010 — shows a team to anybody with masked names, no account ids, and isMe from the session', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const leader = await makeUser('小明明');
    const joiner = await makeUser('😀开心');
    const opened = await placeOrder({ userId: leader, fixture });
    await pay(opened.orderId);
    const joined = await placeOrder({ userId: joiner, fixture, groupId: opened.groupId });
    await pay(joined.orderId);
    const id = { id: String(opened.groupId) };

    const anonymous = await service.groupDetail(harness.as(anonymousActor), id);
    expect(anonymous.members).toEqual([
      { nickname: '小*', avatarUrl: expect.anything(), role: 'leader', isMe: false },
      { nickname: '😀*', avatarUrl: expect.anything(), role: 'member', isMe: false },
    ]);
    // No account id anywhere in what a stranger reads.
    const text = JSON.stringify(anonymous);
    expect(text).not.toContain('userId');
    expect(text).not.toContain('小明明');

    const asJoiner = await service.groupDetail(asUser(joiner), id);
    expect(asJoiner.members.map((m) => m.isMe)).toEqual([false, true]);
    const asLeader = await service.groupDetail(asUser(leader), id);
    expect(asLeader.members.map((m) => m.isMe)).toEqual([true, false]);

    const open = await service.openGroups(
      harness.as(anonymousActor),
      { id: String(fixture.activityId) },
      { page: 1, pageSize: 20 },
    );
    expect(open.items.map((team) => team.leaderNickname)).toEqual(['小*']);
    expect(JSON.stringify(open)).not.toContain('userId');
  });

  it('lets a leader withdraw a team nobody paid into, and not one they did', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const leader = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });

    const view = await service.withdraw(asUser(leader), { id: String(opened.groupId) });
    expect(view.status).toBe('cancelled');

    const other = await makeActivity({ stock: 10 });
    const second = await placeOrder({ userId: leader, fixture: other });
    await pay(second.orderId);
    await expect(
      service.withdraw(asUser(leader), { id: String(second.groupId) }),
    ).rejects.toMatchObject({ code: 'GROUPBUY_GROUP_NOT_WITHDRAWABLE' });
  });

  it('answers the poster with data and a payload, never an image — SHARE-002', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const leader = await makeUser('小明');
    const opened = await placeOrder({ userId: leader, fixture });
    await pay(opened.orderId);

    const poster = await service.poster(asUser(leader), { id: String(opened.groupId) });
    expect(poster.route).toEqual({ route: 'groupbuyTeam', params: { id: String(opened.groupId) } });
    expect(poster.page).toBe(`packages/promo/groupbuy-team/index?id=${opened.groupId}`);
    expect(poster.qrPayload).toBe(poster.page);
    expect(poster.seatsLeft).toBe(2);
    // Masked even for the leader: a poster is made to be passed on (RISK-D-010).
    expect(poster.leaderNickname).toBe('小*');
  });
});

// ---------------------------------------------------------------------------
// 人气条
// ---------------------------------------------------------------------------

/**
 * `summary` counts **distinct users currently taking part**. Counting member
 * rows instead would let refunds, dead teams and repeat joins all push the
 * number up, so it could only ever grow. Each case below is one of the ways
 * that number could lie.
 */
/** The avatars those users joined with, in the order given. */
async function avatarsOf(userIds: readonly number[]): Promise<string[]> {
  const rows = await harness.ctx.db
    .select({ id: users.id, avatarUrl: users.avatarUrl })
    .from(users);
  const byId = new Map(rows.map((row) => [row.id, row.avatarUrl]));
  return userIds.map((userId) => byId.get(userId) ?? '');
}

describe('the 人气条 summary', () => {
  it('counts nobody, and offers no faces, before anybody joins', async () => {
    await makeActivity({ stock: 10 });
    expect(await service.summary(harness.ctx)).toEqual({ participants: 0, avatars: [] });
  });

  it('counts a shopper once however many teams they are in', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const other = await makeActivity({ stock: 10 });
    const keen = await makeUser('小明');
    await pay((await placeOrder({ userId: keen, fixture })).orderId);
    await pay((await placeOrder({ userId: keen, fixture: other })).orderId);

    const summary = await service.summary(harness.ctx);
    expect(summary.participants).toBe(1);
    expect(summary.avatars).toHaveLength(1);
  });

  it('counts a succeeded team, and forgets a failed one', async () => {
    const fixture = await makeActivity({ seatsRequired: 2, stock: 10 });
    const first = await makeUser();
    const second = await makeUser();
    const opened = await placeOrder({ userId: first, fixture });
    await pay(opened.orderId);
    await pay((await placeOrder({ userId: second, fixture, groupId: opened.groupId })).orderId);

    const [group] = await harness.ctx.db
      .select()
      .from(groupbuyGroups)
      .where(eq(groupbuyGroups.id, opened.groupId));
    expect(group?.status).toBe('succeeded');
    expect((await service.summary(harness.ctx)).participants).toBe(2);

    // A team that ran out of time is nobody's 参与中.
    await harness.redis.flushdb();
    const lonely = await makeActivity({ ttlSeconds: 60, stock: 10 });
    const straggler = await makeUser();
    await pay((await placeOrder({ userId: straggler, fixture: lonely })).orderId);
    harness.clock.advance(120_000);
    await settleExpiredGroups(harness.ctx);

    await harness.redis.flushdb();
    expect((await service.summary(harness.ctx)).participants).toBe(2);
  });

  it('drops a member who left, without touching the rest of the team', async () => {
    const fixture = await makeActivity({ seatsRequired: 3, stock: 10 });
    const leader = await makeUser();
    const joiner = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });
    await pay(opened.orderId);
    const joined = await placeOrder({ userId: joiner, fixture, groupId: opened.groupId });
    await pay(joined.orderId);
    expect((await service.summary(harness.ctx)).participants).toBe(2);

    await refund(joined.orderId);
    await harness.redis.flushdb();
    expect((await service.summary(harness.ctx)).participants).toBe(1);
  });

  it('ignores a team on an activity that is no longer live', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const buyer = await makeUser();
    await pay((await placeOrder({ userId: buyer, fixture })).orderId);
    expect((await service.summary(harness.ctx)).participants).toBe(1);

    await harness.ctx.db
      .update(groupbuyActivities)
      .set({ status: 'paused' })
      .where(eq(groupbuyActivities.id, fixture.activityId));
    await harness.redis.flushdb();
    expect((await service.summary(harness.ctx)).participants).toBe(0);
  });

  /**
   * Eight, most recent first, one per person. The bug worth pinning is the
   * de-duplication *order*: take the latest rows and then dedupe, and one
   * shopper in three teams costs two faces.
   */
  it('shows at most eight faces, newest first, one per shopper', async () => {
    const fixture = await makeActivity({ seatsRequired: 12, stock: 40 });
    const opened = await placeOrder({ userId: await makeUser(), fixture });
    await pay(opened.orderId);
    const joiners: number[] = [];
    for (let index = 0; index < 9; index += 1) {
      const userId = await makeUser();
      joiners.push(userId);
      await pay((await placeOrder({ userId, fixture, groupId: opened.groupId })).orderId);
    }

    const summary = await service.summary(harness.ctx);
    expect(summary.participants).toBe(10);
    // Newest first: the last eight joiners. The leader and the first joiner
    // fall off the end, in that order.
    const newest = [...joiners].reverse().slice(0, 8);
    expect(summary.avatars).toEqual(await avatarsOf(newest));
  });

  /**
   * The cache is the point of the route, so it is asserted rather than assumed:
   * a second call must not see a change made in between, and must see it once
   * the key is gone.
   */
  it('serves the same answer for a minute, then recomputes', async () => {
    const fixture = await makeActivity({ seatsRequired: 3, stock: 10 });
    const leader = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });
    await pay(opened.orderId);
    expect((await service.summary(harness.ctx)).participants).toBe(1);

    const joiner = await makeUser();
    await pay((await placeOrder({ userId: joiner, fixture, groupId: opened.groupId })).orderId);
    expect((await service.summary(harness.ctx)).participants).toBe(1);

    await harness.redis.flushdb();
    expect((await service.summary(harness.ctx)).participants).toBe(2);
  });
});

describe('the admin surface', () => {
  it('refuses to delete an activity with a team still forming', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const leader = await makeUser();
    await placeOrder({ userId: leader, fixture });

    await expect(
      service.adminActivityDelete(asAdmin(['groupbuy:activity:delete']), {
        id: String(fixture.activityId),
      }),
    ).rejects.toMatchObject({ code: 'GROUPBUY_ACTIVITY_IN_USE' });
  });

  it('RISK-D-006 — refuses 立即成团 on an under-filled team, whatever the retired switch says', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const leader = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });
    await pay(opened.orderId);

    const admin = asAdmin(['groupbuy:group:read', 'groupbuy:group:complete']);
    await expect(
      service.adminGroupComplete(admin, { id: String(opened.groupId) }, {}),
    ).rejects.toMatchObject({ code: 'GROUPBUY_VIRTUAL_FILL_DISABLED' });

    await storeRetiredVirtualFill();
    await expect(
      service.adminGroupComplete(admin, { id: String(opened.groupId) }, {}),
    ).rejects.toMatchObject({ code: 'GROUPBUY_VIRTUAL_FILL_DISABLED' });
    expect(await readGroup(opened.groupId)).toMatchObject({ status: 'forming', seatsTaken: 1 });
  });

  it('shows 成本价 to whoever edits the activity, not to a role that may only look', async () => {
    const fixture = await makeActivity({ stock: 10 });
    await harness.ctx.db
      .update(groupbuyActivities)
      .set({ cost: '31.00' })
      .where(eq(groupbuyActivities.id, fixture.activityId));
    const params = { id: String(fixture.activityId) };

    const looking = await service.adminActivityDetail(asAdmin(['groupbuy:activity:read']), params);
    expect(looking.cost).toBeNull();
    const editing = await service.adminActivityDetail(
      asAdmin(['groupbuy:activity:read', 'groupbuy:activity:write']),
      params,
    );
    expect(editing.cost).toBe('31.00');
  });

  it('keeps the sales counter across an edit', async () => {
    const fixture = await makeActivity({ stock: 10 });
    const leader = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });
    await pay(opened.orderId);

    const admin = asAdmin(['groupbuy:activity:read', 'groupbuy:activity:write']);
    const before = await service.adminActivityDetail(admin, { id: String(fixture.activityId) });
    const edited = await service.adminActivityUpdate(
      admin,
      { id: String(fixture.activityId) },
      {
        productId: String(fixture.productId),
        title: '改过名字的活动',
        sliderImages: [],
        status: 'active',
        price: '59.00',
        seatsRequired: before.seatsRequired,
        groupTtlSeconds: before.groupTtlSeconds,
        stock: 50,
        perOrderQuantity: 2,
        startAt: before.startAt,
        endAt: before.endAt,
        sortOrder: 0,
        skus: [{ skuId: String(fixture.skuId), price: '59.00', stock: 50, isEnabled: true }],
      },
    );

    // An edit must not reset the counters.
    expect(edited.skus[0]).toMatchObject({ stock: 50, sales: 1 });
    expect(edited.title).toBe('改过名字的活动');
  });

  describe('editing while orders move the stock', () => {
    // The form was opened at 10; a team leader paid since, so the rows say 9.
    async function soldOneSinceTheFormOpened() {
      const fixture = await makeActivity({ stock: 10 });
      await pay((await placeOrder({ userId: await makeUser(), fixture })).orderId);
      expect((await readActivityCounters(fixture)).activity).toEqual({ stock: 9, sales: 1 });
      return fixture;
    }
    async function edit(
      fixture: ActivityFixture,
      stock: { activity: number; sku: number; expected: number },
      status: 'active' | 'ended' = 'active',
      sku: 'kept' | 'removed' | 'switched-off' = 'kept',
    ) {
      const admin = asAdmin(['groupbuy:activity:read', 'groupbuy:activity:write']);
      const before = await service.adminActivityDetail(admin, { id: String(fixture.activityId) });
      return service.adminActivityUpdate(
        admin,
        { id: String(fixture.activityId) },
        {
          productId: String(fixture.productId),
          title: '改过名字的活动',
          sliderImages: [],
          status,
          price: '59.00',
          seatsRequired: before.seatsRequired,
          groupTtlSeconds: before.groupTtlSeconds,
          stock: stock.activity,
          expectedStock: stock.expected,
          perOrderQuantity: 2,
          startAt: before.startAt,
          endAt: before.endAt,
          sortOrder: 0,
          skus:
            sku === 'removed'
              ? []
              : [
                  {
                    skuId: String(fixture.skuId),
                    price: '59.00',
                    stock: stock.sku,
                    expectedStock: stock.expected,
                    isEnabled: sku === 'kept',
                  },
                ],
        },
      );
    }

    it('RISK-D-012 — refuses to remove a SKU that has sold, and lets it be switched off instead', async () => {
      const fixture = await soldOneSinceTheFormOpened();
      await expect(
        edit(fixture, { activity: 10, sku: 10, expected: 10 }, 'active', 'removed'),
      ).rejects.toMatchObject({
        code: 'GROUPBUY_ACTIVITY_SKU_IN_USE',
        details: { skuIds: [String(fixture.skuId)] },
      });
      // Switched off, it keeps its 已售 — the counters are the order history.
      await edit(fixture, { activity: 10, sku: 10, expected: 10 }, 'active', 'switched-off');
      expect((await readActivityCounters(fixture)).sku).toEqual({ stock: 9, sales: 1 });
    });

    it('RISK-D-012 — refuses to remove a SKU an unpaid order is still buying', async () => {
      const fixture = await makeActivity({ stock: 10 });
      await placeOrder({ userId: await makeUser(), fixture });
      await expect(
        edit(fixture, { activity: 10, sku: 10, expected: 9 }, 'active', 'removed'),
      ).rejects.toMatchObject({ code: 'GROUPBUY_ACTIVITY_SKU_IN_USE' });
    });

    it('keeps the live stock when the operator only fixed the title', async () => {
      const fixture = await soldOneSinceTheFormOpened();
      await edit(fixture, { activity: 10, sku: 10, expected: 10 });
      const after = await readActivityCounters(fixture);
      expect(after.activity).toEqual({ stock: 9, sales: 1 });
      expect(after.sku).toEqual({ stock: 9, sales: 1 });
    });

    it('refuses a changed stock the form saw before the sale', async () => {
      const fixture = await soldOneSinceTheFormOpened();
      await expect(edit(fixture, { activity: 50, sku: 10, expected: 10 })).rejects.toMatchObject({
        code: 'GROUPBUY_STOCK_CHANGED',
        details: { expected: 10, current: 9 },
      });
      await expect(edit(fixture, { activity: 10, sku: 50, expected: 10 })).rejects.toMatchObject({
        code: 'GROUPBUY_STOCK_CHANGED',
        details: { skuId: fixture.skuId, expected: 10, current: 9 },
      });
      expect((await readActivityCounters(fixture)).activity).toEqual({ stock: 9, sales: 1 });
    });

    it('writes a changed stock over the number the form saw', async () => {
      const fixture = await soldOneSinceTheFormOpened();
      await edit(fixture, { activity: 50, sku: 40, expected: 9 });
      const after = await readActivityCounters(fixture);
      expect(after.activity).toEqual({ stock: 50, sales: 1 });
      expect(after.sku).toEqual({ stock: 40, sales: 1 });
    });

    it('does not re-open an ended campaign', async () => {
      const fixture = await makeActivity({ stock: 10 });
      await harness.ctx.db
        .update(groupbuyActivities)
        .set({ status: 'ended' })
        .where(eq(groupbuyActivities.id, fixture.activityId));
      await expect(edit(fixture, { activity: 10, sku: 10, expected: 10 })).rejects.toMatchObject({
        code: 'GROUPBUY_ACTIVITY_ENDED',
      });
      const kept = await edit(fixture, { activity: 10, sku: 10, expected: 10 }, 'ended');
      expect(kept.status).toBe('ended');
    });
  });

  it('reports what a campaign did', async () => {
    const fixture = await makeActivity({ seatsRequired: 2, stock: 10 });
    const leader = await makeUser();
    const joiner = await makeUser();
    const opened = await placeOrder({ userId: leader, fixture });
    await pay(opened.orderId);
    const joined = await placeOrder({ userId: joiner, fixture, groupId: opened.groupId });
    await pay(joined.orderId);

    const admin = asAdmin(['groupbuy:activity:read']);
    const stats = await service.adminStatistics(admin, { page: 1, pageSize: 20 });
    expect(stats.items[0]).toMatchObject({
      activityId: String(fixture.activityId),
      groups: 1,
      succeededGroups: 1,
      paidMembers: 2,
      paidAmount: '118.00',
      refundedMembers: 0,
    });

    const list = await service.adminActivityOrders(
      admin,
      { id: String(fixture.activityId) },
      { page: 1, pageSize: 20, paid: true },
    );
    expect(list.total).toBe(2);
    expect(list.items.every((item) => item.paid)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

async function allMembers(groupId: number) {
  return harness.ctx.db
    .select()
    .from(groupbuyMembers)
    .where(eq(groupbuyMembers.groupId, groupId))
    .orderBy(groupbuyMembers.id);
}

/**
 * What a shop that had 虚拟成团 switched on before 2026-09-23 still has stored:
 * the key the `groupbuy` group no longer declares.
 */
async function storeRetiredVirtualFill(): Promise<void> {
  await harness.ctx.db
    .insert(configValues)
    .values({ group: 'groupbuy', key: 'virtualFillOnExpiry', value: true });
  await harness.ctx.config.invalidate(groupbuyConfig.group);
}

// ---------------------------------------------------------------------------
// shopper notifications
// ---------------------------------------------------------------------------

/**
 * What a shopper is told, end to end: the group-buy effect records the notice,
 * the notification effect fans it out, and every channel the operator switched
 * on receives the rendered payload.
 *
 * WeChat is the fake `api.weixin.qq.com` from `@shop/testing`; SMS is a
 * recording port. Nothing here reaches a real provider.
 */
describe('shopper notifications', () => {
  let oa: FakeOaServer;
  const sms: { calls: Parameters<SmsPort['send']>[1][] } = { calls: [] };
  const superAdmin = (): Ctx =>
    harness.as({ kind: 'admin', id: 1, permissions: [], isSuper: true });

  beforeAll(async () => {
    oa = await startFakeOaServer();
    process.env['PUBLIC_ORIGIN'] = 'https://shop.example.test';
  });

  afterAll(async () => {
    delete process.env['PUBLIC_ORIGIN'];
    await oa?.close();
  });

  beforeEach(async () => {
    oa.reset();
    resetWechatTokenFlight();
    sms.calls = [];
    registerSmsPort({
      async send(_ctx, input) {
        sms.calls.push(input);
        return { ok: true };
      },
    });
    await harness.ctx.config.set(wechatConfig, {
      oaAppId: oa.appId,
      oaAppSecret: oa.appSecret,
      miniAppId: oa.miniAppId,
      miniAppSecret: oa.miniAppSecret,
      apiBaseUrl: oa.url,
    });
  });

  /**
   * Runs the pending effects of the named types, and the ones they record, the
   * way the dispatcher would — but only those: `refund.execute` would call the
   * payment gateway, and this suite is about what the shopper is told.
   */
  async function runEffects(types: readonly string[]): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      const due = await harness.ctx.db
        .select()
        .from(effects)
        .where(and(eq(effects.status, 'pending'), inArray(effects.eventType, [...types])));
      if (due.length === 0) return;
      for (const row of due) {
        await getEffectHandler(row.scope, row.eventType)!(harness.ctx, {
          id: row.id,
          scope: row.scope,
          scopeId: row.scopeId,
          eventType: row.eventType,
          payload: row.payload,
          attempts: 1,
        });
        await harness.ctx.db.update(effects).set({ status: 'done' }).where(eq(effects.id, row.id));
      }
    }
    throw new Error('effects kept recording effects');
  }

  const SEND = 'notification.send';

  const inbox = (userId: number) =>
    harness.ctx.db
      .select()
      .from(notificationMessages)
      .where(eq(notificationMessages.userId, userId));

  async function fullTeam(seats = 2) {
    const fixture = await makeActivity({ seatsRequired: seats });
    const shoppers: { userId: number; orderId: number }[] = [];
    let groupId = 0;
    for (let seat = 0; seat < seats; seat += 1) {
      const userId = await makeUser();
      const placed = await placeOrder({
        userId,
        fixture,
        ...(groupId ? { groupId } : {}),
      });
      groupId = placed.groupId;
      await pay(placed.orderId);
      shoppers.push({ userId, orderId: placed.orderId });
    }
    const [activity] = await harness.ctx.db
      .select({ title: groupbuyActivities.title })
      .from(groupbuyActivities)
      .where(eq(groupbuyActivities.id, fixture.activityId));
    return { fixture, groupId, shoppers, title: activity!.title };
  }

  async function orderNoOf(orderId: number): Promise<string> {
    const [row] = await harness.ctx.db
      .select({ orderNo: orders.orderNo })
      .from(orders)
      .where(eq(orders.id, orderId));
    return row!.orderNo;
  }

  it('tells the leader 开团成功 and a joiner 参团成功, once each however often the effect runs', async () => {
    const fixture = await makeActivity({ seatsRequired: 3, ttlSeconds: 3_600 });
    const leaderId = await makeUser();
    const leader = await placeOrder({ userId: leaderId, fixture });
    await pay(leader.orderId);
    const joinerId = await makeUser();
    const joiner = await placeOrder({ userId: joinerId, fixture, groupId: leader.groupId });
    await pay(joiner.orderId);

    await runEffects(['groupbuy.join', SEND]);
    // A retried `groupbuy.join` finds the notice already recorded.
    await harness.ctx.db
      .update(effects)
      .set({ status: 'pending' })
      .where(eq(effects.eventType, 'groupbuy.join'));
    await runEffects(['groupbuy.join', SEND]);

    const [opened] = await inbox(leaderId);
    expect(await inbox(leaderId)).toHaveLength(1);
    expect(opened).toMatchObject({ code: 'groupbuy_created', title: '开团成功' });
    expect(opened?.content).toContain('3 人成团，请在 2026-06-01 09:00 前邀请好友参团');
    expect(opened?.data).toMatchObject({
      route: { route: 'groupbuyTeam', params: { id: String(leader.groupId) } },
    });
    expect(opened?.data).not.toHaveProperty('link');

    const [joined] = await inbox(joinerId);
    expect(await inbox(joinerId)).toHaveLength(1);
    expect(joined).toMatchObject({ code: 'groupbuy_joined', title: '参团成功' });
  });

  it('tells every paid member 拼团成功 when the team fills, on every channel switched on — NOTIF-006', async () => {
    // The operator configures the event in 通知管理 before the team fills.
    const current = await notificationAdmin.getTemplate(superAdmin(), {
      code: 'groupbuy_succeeded',
    });
    await notificationAdmin.saveTemplate(
      superAdmin(),
      { code: 'groupbuy_succeeded' },
      {
        isEnabled: true,
        channels: {
          ...current.channels,
          wechatOa: {
            enabled: true,
            templateKey: 'OPENTM1',
            templateId: 'TPL_OA_GROUP_OK',
            fields: { first: '拼团成功', keyword1: '{{orderNo}}', keyword2: '{{activityTitle}}' },
            // The only link a 公众号 message carries is the one the operator typed.
            linkUrl: '/groupbuy/teams/{{groupId}}',
          },
          wechatMini: {
            enabled: true,
            templateKey: '1001',
            templateId: 'TPL_MINI_GROUP_OK',
            fields: { character_string1: '{{orderNo}}', thing2: '{{activityTitle}}' },
          },
          sms: {
            enabled: true,
            templateCode: 'SMS_GROUP_OK',
            params: [{ name: 'title', value: '{{activityTitle}}' }],
          },
        },
      },
    );

    const team = await fullTeam(2);
    for (const [index, shopper] of team.shoppers.entries()) {
      await harness.ctx.db.insert(wechatIdentities).values([
        { userId: shopper.userId, platform: 'oa', openid: `oa-openid-${index}` },
        { userId: shopper.userId, platform: 'mini', openid: `mini-openid-${index}` },
      ]);
    }

    await runEffects(['groupbuy.settle', SEND]);

    for (const [index, shopper] of team.shoppers.entries()) {
      const orderNo = await orderNoOf(shopper.orderId);
      const messages = await inbox(shopper.userId);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ code: 'groupbuy_succeeded', title: '拼团成功' });
      expect(messages[0]?.content).toBe(
        `「${team.title}」拼团成功，订单 ${orderNo} 将尽快为您发货。`,
      );

      const oaSend = oa
        .callsTo('/cgi-bin/message/template/send')
        .find((call) => (call.body as { touser: string }).touser === `oa-openid-${index}`);
      expect(oaSend?.body).toEqual({
        touser: `oa-openid-${index}`,
        template_id: 'TPL_OA_GROUP_OK',
        url: `https://shop.example.test/groupbuy/teams/${team.groupId}`,
        data: {
          first: { value: '拼团成功' },
          keyword1: { value: orderNo },
          keyword2: { value: team.title },
        },
      });

      const miniSend = oa
        .callsTo('/cgi-bin/message/subscribe/send')
        .find((call) => (call.body as { touser: string }).touser === `mini-openid-${index}`);
      expect(miniSend?.body).toMatchObject({
        template_id: 'TPL_MINI_GROUP_OK',
        page: `packages/promo/groupbuy-team/index?id=${team.groupId}`,
        data: { character_string1: { value: orderNo }, thing2: { value: team.title } },
      });

      const text = sms.calls.find((call) => call.userId === shopper.userId);
      expect(text).toMatchObject({
        templateCode: 'SMS_GROUP_OK',
        notificationCode: 'groupbuy_succeeded',
      });
      // Exactly the template's variables, never the event's payload.
      expect(text?.params).toEqual([{ name: 'title', value: team.title }]);
    }
    expect(oa.callsTo('/cgi-bin/message/template/send')).toHaveLength(2);
    expect(oa.callsTo('/cgi-bin/message/subscribe/send')).toHaveLength(2);
    expect(sms.calls).toHaveLength(2);
  });

  it('tells each paid member 拼团失败 in the transaction that opened their refund', async () => {
    const fixture = await makeActivity({ seatsRequired: 3, ttlSeconds: 3_600 });
    const leaderId = await makeUser();
    const leader = await placeOrder({ userId: leaderId, fixture });
    await pay(leader.orderId);
    const joinerId = await makeUser();
    const joiner = await placeOrder({ userId: joinerId, fixture, groupId: leader.groupId });
    await pay(joiner.orderId);

    harness.clock.set('2026-06-01T02:00:00.000Z');
    await settleExpiredGroups(harness.ctx);

    // The team has failed, but until the refund is open there is nothing to say.
    await runEffects(['groupbuy.settle', SEND]);
    const failedNotices = () =>
      harness.ctx.db
        .select()
        .from(effects)
        .where(and(eq(effects.eventType, SEND), eq(effects.scope, 'notification')))
        .then((rows) => rows.filter((row) => row.scopeId.startsWith('groupbuy_failed:')));
    expect(await failedNotices()).toHaveLength(0);

    await runEffects(['groupbuy.refund', SEND]);

    for (const { userId, orderId } of [
      { userId: leaderId, orderId: leader.orderId },
      { userId: joinerId, orderId: joiner.orderId },
    ]) {
      const [refundRow] = await harness.ctx.db
        .select()
        .from(refunds)
        .where(eq(refunds.orderId, orderId));
      expect(refundRow).toBeDefined();

      const messages = (await inbox(userId)).filter((row) => row.code === 'groupbuy_failed');
      expect(messages).toHaveLength(1);
      expect(messages[0]?.title).toBe('拼团失败');
      expect(messages[0]?.content).toContain('拼团人数未满，未能成团');
      expect(messages[0]?.content).toContain(
        `订单 ${await orderNoOf(orderId)} 的 ¥59.00 将原路退回`,
      );
      expect(messages[0]?.data).toMatchObject({ refundId: String(refundRow!.id) });
    }
    expect(await failedNotices()).toHaveLength(2);
  });

  it('sends nothing for an event the operator switched off in 通知管理', async () => {
    const current = await notificationAdmin.getTemplate(superAdmin(), {
      code: 'groupbuy_succeeded',
    });
    await notificationAdmin.saveTemplate(
      superAdmin(),
      { code: 'groupbuy_succeeded' },
      { isEnabled: false, channels: current.channels },
    );

    const team = await fullTeam(2);
    await runEffects(['groupbuy.settle', SEND]);

    for (const shopper of team.shoppers) {
      expect(await inbox(shopper.userId)).toHaveLength(0);
    }
    expect(oa.callsTo('/cgi-bin/message/template/send')).toHaveLength(0);
    expect(sms.calls).toHaveLength(0);
  });

  it('lists the four events in 通知管理 with in-app on, over the empty shells the seed writes', async () => {
    // What `db:seed` leaves in the table on every deploy: no channels at all.
    await harness.ctx.db
      .insert(notificationTemplates)
      .values(
        ['groupbuy_created', 'groupbuy_joined', 'groupbuy_succeeded', 'groupbuy_failed'].map(
          (code) => ({ code, name: code, audience: 'user' as const, variables: ['orderNo'] }),
        ),
      );

    const page = await notificationAdmin.listTemplates(superAdmin(), {
      page: 1,
      pageSize: 50,
      keyword: 'groupbuy_',
    });
    expect(page.items.map((row) => row.code)).toEqual([
      'groupbuy_created',
      'groupbuy_failed',
      'groupbuy_joined',
      'groupbuy_succeeded',
    ]);
    for (const row of page.items) {
      expect(row.channels.inApp?.enabled).toBe(true);
      expect(row.channels.wechatOa?.enabled).toBe(false);
      expect(row.variables).toContain('orderNo');
    }
    expect(page.items.find((row) => row.code === 'groupbuy_failed')?.channels.inApp?.body).toBe(
      '「{{activityTitle}}」{{reason}}，订单 {{orderNo}} {{refundNote}}。',
    );
  });
});
