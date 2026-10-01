import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { products, productSkus } from '@shop/db/schema/catalog';
import { effects } from '@shop/db/schema/system';
import {
  groupbuyActivities,
  groupbuyActivitySkus,
  groupbuyGroups,
  groupbuyMembers,
} from '@shop/db/schema/groupbuy';
import { orderItems, orders } from '@shop/db/schema/order';
import { users } from '@shop/db/schema/user';
import { createTestCtx, forkTestCtx, runConcurrently, type TestCtx } from '@shop/testing';
import type { Actor, Ctx } from '../kernel/context';
import { Money } from '../kernel/money';
import { withTx } from '../kernel/tx';
import { onOrderPaid, onOrderRefunded, resetOrderPorts } from '../order/ports';
import { groupbuyConfig } from './groupbuy.config';
import { clearAutoRefundPort } from './groupbuy.effects';
import { settleGroup } from './groupbuy.jobs';
import { groupbuyKindHandler } from './groupbuy.order';
import { registerGroupbuyDomain } from './index';

/**
 * The races. This is the point of the domain.
 *
 * Every conditional state change in the group-buy domain is here: the seat
 * (`takeSeat`), the four activity ledgers (`reserveActivityStock`), the team's
 * fate (`succeedGroup`, `failGroup`, `cancelEmptyGroup`) and the leadership
 * handover. Each one is a statement whose `WHERE` carries the condition, and
 * the only way to prove that is to make real connections collide on real rows.
 *
 * Two things make these real rather than decorative:
 *
 *  - `runConcurrently` releases every caller from one barrier, so they meet
 *    inside the same statement instead of running in sequence;
 *  - each caller gets its own `Ctx` from `forkTestCtx`, so they hold different
 *    pooled connections. One shared connection would serialise them and every
 *    assertion below would pass for the wrong reason.
 *
 * The money invariant, stated once and checked everywhere: **a shopper whose
 * money was taken is either in a team that holds a seat for them, or has a
 * `groupbuy.refund` effect asking for it back.** Never neither.
 */

let harness: TestCtx;

const NOW = '2026-06-01T00:00:00.000Z';
const PRICE = '59.00';

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.ctx.config.invalidate(groupbuyConfig.group);
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

/** A caller on its own connection, acting as this shopper. */
const racer = (userId: number): Ctx => forkTestCtx(harness, { actor: userActor(userId) });

let sequence = 0;

interface Placed {
  userId: number;
  orderId: number;
  groupId: number;
}

interface ActivityFixture {
  activityId: number;
  productId: number;
  skuId: number;
  seatsRequired: number;
}

async function makeUser(): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({ account: `gb-race-${sequence}`, nickname: `顾客${sequence}` })
    .returning({ id: users.id });
  return row!.id;
}

async function makeUsers(n: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i += 1) ids.push(await makeUser());
  return ids;
}

async function makeActivity(
  over: {
    seatsRequired?: number;
    stock?: number;
    totalQuota?: number | null;
    ttlSeconds?: number;
  } = {},
): Promise<ActivityFixture> {
  sequence += 1;
  const stock = over.stock ?? 100;
  const seatsRequired = over.seatsRequired ?? 2;

  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `坚果礼盒${sequence}`,
      imageUrl: 'https://example.test/p.png',
      freightMode: 'free',
      price: '88.00',
      stock: 1_000,
    })
    .returning({ id: products.id });
  const [sku] = await harness.ctx.db
    .insert(productSkus)
    .values({
      productId: product!.id,
      skuCode: `SKU-R-${sequence}`,
      specText: '混合装|1000g',
      specValues: { 规格: '混合装' },
      price: '88.00',
      originalPrice: '108.00',
      stock: 1_000,
    })
    .returning({ id: productSkus.id });

  const [activity] = await harness.ctx.db
    .insert(groupbuyActivities)
    .values({
      productId: product!.id,
      title: `${seatsRequired}人成团${sequence}`,
      imageUrl: 'https://example.test/p.png',
      status: 'active',
      price: PRICE,
      originalPrice: '88.00',
      seatsRequired,
      groupTtlSeconds: over.ttlSeconds ?? 86_400,
      stock,
      totalQuota: over.totalQuota === undefined ? null : over.totalQuota,
      perOrderQuantity: 2,
      startAt: new Date('2026-05-01T00:00:00.000Z'),
      endAt: new Date('2026-07-01T00:00:00.000Z'),
    })
    .returning({ id: groupbuyActivities.id });

  await harness.ctx.db.insert(groupbuyActivitySkus).values({
    activityId: activity!.id,
    skuId: sku!.id,
    price: PRICE,
    stock,
    quota: over.totalQuota === undefined ? null : over.totalQuota,
    isEnabled: true,
  });

  return { activityId: activity!.id, productId: product!.id, skuId: sku!.id, seatsRequired };
}

async function makeOrder(ctx: Ctx, userId: number, fixture: ActivityFixture): Promise<number> {
  sequence += 1;
  const orderNo = `GBR${String(sequence).padStart(9, '0')}`;
  const [order] = await ctx.db
    .insert(orders)
    .values({
      orderNo,
      userId,
      platform: 'h5',
      kind: 'groupbuy',
      status: 'pending_payment',
      totalQuantity: 1,
      itemsAmount: PRICE,
      payableAmount: PRICE,
      receiverName: '张三',
      receiverPhone: '13800000000',
      receiverProvince: '广东省',
      receiverCity: '深圳市',
      receiverDetail: '某路 1 号',
    })
    .returning({ id: orders.id });
  await ctx.db.insert(orderItems).values({
    orderId: order!.id,
    productId: fixture.productId,
    skuId: fixture.skuId,
    itemKey: `line-${sequence}`,
    quantity: 1,
    unitPrice: PRICE,
    totalAmount: PRICE,
    snapshot: { name: '坚果礼盒' } as never,
  });
  return order!.id;
}

/** The checkout's two halves, in one transaction, on this caller's connection. */
async function placeOrder(
  ctx: Ctx,
  args: { userId: number; fixture: ActivityFixture; groupId?: number },
): Promise<{ orderId: number; groupId: number }> {
  const orderId = await makeOrder(ctx, args.userId, args.fixture);
  await withTx(ctx.db, async (tx) => {
    const meta = await groupbuyKindHandler.beforeCreate(ctx, tx, {
      userId: args.userId,
      lines: [
        {
          skuId: args.fixture.skuId,
          productId: args.fixture.productId,
          quantity: 1,
          unitPrice: Money.parse(PRICE),
          subtotal: Money.parse(PRICE),
        },
      ],
      goodsTotal: Money.parse(PRICE),
      selections: {
        activityId: String(args.fixture.activityId),
        ...(args.groupId === undefined ? {} : { groupId: String(args.groupId) }),
      },
    } as never);
    await groupbuyKindHandler.afterCreate(ctx, tx, orderId, meta);
  });
  const [member] = await ctx.db
    .select({ groupId: groupbuyMembers.groupId })
    .from(groupbuyMembers)
    .where(eq(groupbuyMembers.orderId, orderId));
  return { orderId, groupId: member!.groupId };
}

/** The payment domain's paid callback, on this caller's connection. */
async function pay(ctx: Ctx, orderId: number): Promise<void> {
  const at = ctx.clock.now();
  await withTx(ctx.db, async (tx) => {
    await tx
      .update(orders)
      .set({ status: 'paid', paidAt: at, paidAmount: PRICE })
      .where(eq(orders.id, orderId));
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    await onOrderPaid.dispatch(tx, ctx, {
      orderId,
      orderNo: order!.orderNo,
      userId: order!.userId,
      at,
      paidAmount: Money.parse(PRICE),
    });
  });
}

async function refund(ctx: Ctx, orderId: number): Promise<void> {
  const at = ctx.clock.now();
  await withTx(ctx.db, async (tx) => {
    await tx.update(orders).set({ status: 'refunded' }).where(eq(orders.id, orderId));
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    await onOrderRefunded.dispatch(tx, ctx, {
      orderId,
      orderNo: order!.orderNo,
      userId: order!.userId,
      at,
      refundId: 1,
      refundedAmount: Money.parse(PRICE),
      partial: false,
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

async function readLedgers(fixture: ActivityFixture) {
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

async function members(groupId: number) {
  return harness.ctx.db
    .select()
    .from(groupbuyMembers)
    .where(eq(groupbuyMembers.groupId, groupId))
    .orderBy(groupbuyMembers.id);
}

async function refundRequests(orderId: number): Promise<number> {
  const rows = await harness.ctx.db
    .select({ id: effects.id })
    .from(effects)
    .where(
      and(
        eq(effects.scope, 'order'),
        eq(effects.scopeId, String(orderId)),
        eq(effects.eventType, 'groupbuy.refund'),
      ),
    );
  return rows.length;
}

// ---------------------------------------------------------------------------

describe('the last seat', () => {
  /**
   * STOCK-004 / the headline race. A two-seat team whose leader has paid has one
   * seat left; five joiners pay for it at the same instant.
   *
   * Counting rows before inserting would produce a six-person two-person team.
   * `takeSeat` carries `seats_taken < seats_total` in its `WHERE`: one caller
   * wins, four are refunded, and the team is full rather than over-full.
   */
  it('goes to exactly one of five simultaneous payers', async () => {
    const fixture = await makeActivity({ seatsRequired: 2, stock: 20 });
    const [leader, ...joiners] = await makeUsers(6);
    const opened = await placeOrder(racer(leader!), { userId: leader!, fixture });
    await pay(racer(leader!), opened.orderId);

    const placed: Placed[] = [];
    for (const userId of joiners) {
      placed.push({
        userId,
        ...(await placeOrder(racer(userId), { userId, fixture, groupId: opened.groupId })),
      });
    }

    await runConcurrently(placed.length, async (index) => {
      const entry = placed[index]!;
      await pay(racer(entry.userId), entry.orderId);
    });

    const group = await readGroup(opened.groupId);
    expect(group.seatsTaken).toBe(2);
    expect(group.status).toBe('succeeded');

    const rows = await members(opened.groupId);
    expect(rows.filter((row) => row.status === 'joined')).toHaveLength(2);
    expect(rows.filter((row) => row.status === 'refunded')).toHaveLength(4);

    // Every loser's money is asked for back, and their stock is released.
    for (const entry of placed) {
      const row = rows.find((m) => m.orderId === entry.orderId)!;
      if (row.status === 'refunded') expect(await refundRequests(entry.orderId)).toBe(1);
      else expect(await refundRequests(entry.orderId)).toBe(0);
    }

    // Two seats sold out of six reservations; the other four went back.
    expect(await readLedgers(fixture)).toEqual({
      activity: { stock: 18, sales: 2 },
      sku: { stock: 18, sales: 2 },
    });
  });

  /**
   * The same statement seen from the team's side: `succeedGroup` carries
   * `seats_taken = seats_total`, so the loser of the last seat does not raise a
   * `groupbuy_groups_succeeded_is_full` violation and take the whole payment
   * transaction down with it.
   */
  it('completes the team once and only once', async () => {
    const fixture = await makeActivity({ seatsRequired: 3, stock: 20 });
    const users = await makeUsers(3);
    const opened = await placeOrder(racer(users[0]!), { userId: users[0]!, fixture });
    const placed = [{ userId: users[0]!, ...opened }];
    for (const userId of users.slice(1)) {
      placed.push({
        userId,
        ...(await placeOrder(racer(userId), { userId, fixture, groupId: opened.groupId })),
      });
    }

    const report = await runConcurrently(placed.length, async (index) => {
      const entry = placed[index]!;
      await pay(racer(entry.userId), entry.orderId);
      return true;
    });
    expect(report.rejected).toEqual([]);

    expect(await readGroup(opened.groupId)).toMatchObject({ status: 'succeeded', seatsTaken: 3 });
    const settled = await harness.ctx.db
      .select({ id: effects.id })
      .from(effects)
      .where(
        and(
          eq(effects.scope, 'groupbuy'),
          eq(effects.scopeId, String(opened.groupId)),
          eq(effects.eventType, 'groupbuy.settle'),
        ),
      );
    expect(settled).toHaveLength(1);
  });
});

describe('the activity ledgers', () => {
  /**
   * STOCK-004. The activity's own stock is not the SKU's: a campaign of 3 out of
   * a warehouse of 1000 must sell 3. Eight shoppers check out at once.
   */
  it('never oversell the campaign, however many place at once', async () => {
    const fixture = await makeActivity({ seatsRequired: 2, stock: 3 });
    const users = await makeUsers(8);

    const report = await runConcurrently(users.length, async (index) => {
      const userId = users[index]!;
      try {
        await placeOrder(racer(userId), { userId, fixture });
        return true;
      } catch {
        return false;
      }
    });

    expect(report.winners).toBe(3);
    expect(await readLedgers(fixture)).toEqual({
      activity: { stock: 0, sales: 0 },
      sku: { stock: 0, sales: 0 },
    });
  });

  /**
   * The same thing at the width of the pool.
   *
   * The harness opens twelve connections, and `beforeCreate` runs while its
   * caller already holds one of them. A handler that reaches for a second — the
   * shape presale's price guard had before the applied adjustments reached the
   * draft — leaves twelve callers each holding one and wanting one, and this
   * test hangs instead of failing. Twelve is therefore not an arbitrary crowd:
   * it is exactly the number that turns that mistake into a red suite.
   */
  it('holds under a crowd the width of the pool', async () => {
    const fixture = await makeActivity({ seatsRequired: 2, stock: 3 });
    const users = await makeUsers(12);

    const report = await runConcurrently(users.length, async (index) => {
      const userId = users[index]!;
      try {
        await placeOrder(racer(userId), { userId, fixture });
        return true;
      } catch {
        return false;
      }
    });

    expect(report.winners).toBe(3);
    expect(report.losers).toBe(9);
    expect(await readLedgers(fixture)).toEqual({
      activity: { stock: 0, sales: 0 },
      sku: { stock: 0, sales: 0 },
    });
  });

  /**
   * The quota is a ceiling on *sales*, and sales only move when money arrives,
   * so the guard that counts is the one in `commitActivitySales`. Six shoppers
   * hold a reservation each and then pay at the same instant: two sales land,
   * four are refunded. A reservation-time check alone would have let all six
   * through a quota of two, because at reservation time `sales` is still zero.
   */
  it('never oversell the quota either', async () => {
    const fixture = await makeActivity({ seatsRequired: 2, stock: 20, totalQuota: 2 });
    const users = await makeUsers(6);

    const placed: Placed[] = [];
    for (const userId of users) {
      placed.push({ userId, ...(await placeOrder(racer(userId), { userId, fixture })) });
    }

    const report = await runConcurrently(placed.length, async (index) => {
      const entry = placed[index]!;
      await pay(racer(entry.userId), entry.orderId);
      return true;
    });
    expect(report.rejected).toEqual([]);

    // Two sold; the other four gave their reservation back and want a refund.
    expect(await readLedgers(fixture)).toEqual({
      activity: { stock: 18, sales: 2 },
      sku: { stock: 18, sales: 2 },
    });
    let refunded = 0;
    for (const entry of placed) refunded += await refundRequests(entry.orderId);
    expect(refunded).toBe(4);
  });

  /**
   * The four-ledger rollback: activity stock, activity sales, SKU stock, SKU
   * sales. Four shoppers pay and then all four refund at the same instant; the
   * ledgers must land exactly where they started, not one short and not one
   * over.
   */
  it('return to where they started when everybody refunds at once', async () => {
    const fixture = await makeActivity({ seatsRequired: 4, stock: 10 });
    const users = await makeUsers(4);
    const opened = await placeOrder(racer(users[0]!), { userId: users[0]!, fixture });
    const placed = [{ userId: users[0]!, ...opened }];
    for (const userId of users.slice(1)) {
      placed.push({
        userId,
        ...(await placeOrder(racer(userId), { userId, fixture, groupId: opened.groupId })),
      });
    }
    for (const entry of placed) await pay(racer(entry.userId), entry.orderId);
    expect(await readLedgers(fixture)).toEqual({
      activity: { stock: 6, sales: 4 },
      sku: { stock: 6, sales: 4 },
    });

    const report = await runConcurrently(placed.length, async (index) => {
      const entry = placed[index]!;
      await refund(racer(entry.userId), entry.orderId);
      return true;
    });
    expect(report.rejected).toEqual([]);

    expect(await readLedgers(fixture)).toEqual({
      activity: { stock: 10, sales: 0 },
      sku: { stock: 10, sales: 0 },
    });
    // The team completed before the refunds, so it stays complete and full.
    expect(await readGroup(opened.groupId)).toMatchObject({ status: 'succeeded', seatsTaken: 4 });
  });
});

describe('a payment landing as the team expires', () => {
  /**
   * The "join vs team expiry" race, and the one that can strand a shopper's
   * money. `settleGroup` locks the group row; `takeSeat` blocks on that lock
   * and then re-reads, so exactly one of the two outcomes happens:
   *
   *  - the payment got in first: the member holds a seat, and the sweep sees a
   *    paid member and asks for their money back;
   *  - the sweep got in first: `takeSeat` loses its `status = 'forming'` guard
   *    and the payment's own loss path asks for the money back.
   *
   * Either way there is exactly one refund request for the money that moved,
   * and the team is `failed` rather than half-settled.
   */
  it('either takes the seat or is refunded — never neither, never both', async () => {
    for (let round = 0; round < 6; round += 1) {
      await harness.db.truncateAll();
      harness.clock.set(NOW);

      const fixture = await makeActivity({ seatsRequired: 3, stock: 10, ttlSeconds: 3_600 });
      const [leader, joiner] = await makeUsers(2);
      const opened = await placeOrder(racer(leader!), { userId: leader!, fixture });
      const joined = await placeOrder(racer(joiner!), {
        userId: joiner!,
        fixture,
        groupId: opened.groupId,
      });
      await pay(racer(leader!), opened.orderId);
      harness.clock.set('2026-06-01T02:00:00.000Z');

      await runConcurrently(2, async (index) => {
        if (index === 0) await pay(racer(joiner!), joined.orderId);
        else await settleGroup(forkTestCtx(harness), opened.groupId);
      });

      const group = await readGroup(opened.groupId);
      expect(group.status).toBe('failed');

      // Both shoppers paid; both must be asked for their money back exactly
      // once, whichever order the two transactions committed in.
      expect(await refundRequests(opened.orderId)).toBe(1);
      expect(await refundRequests(joined.orderId)).toBe(1);

      const rows = await members(opened.groupId);
      for (const row of rows) {
        // A refunded member released their stock; a joined one has not yet,
        // because the money has not actually come back yet.
        expect(['joined', 'refunded']).toContain(row.status);
      }
    }
  });

  /** Two sweeps of the same expired team settle it once. */
  it('settles once even when two sweeps collide', async () => {
    const fixture = await makeActivity({ seatsRequired: 3, stock: 10, ttlSeconds: 3_600 });
    const leader = await makeUser();
    const opened = await placeOrder(racer(leader), { userId: leader, fixture });
    await pay(racer(leader), opened.orderId);
    harness.clock.set('2026-06-01T02:00:00.000Z');

    const report = await runConcurrently(
      4,
      async () => settleGroup(forkTestCtx(harness), opened.groupId),
      { isWinner: (result) => result.outcome === 'failed' },
    );

    expect(report.winners).toBe(1);
    expect(await refundRequests(opened.orderId)).toBe(1);
    expect(await readGroup(opened.groupId)).toMatchObject({ status: 'failed' });
  });
});

describe('leadership', () => {
  /**
   * The leader's refund promotes an heir while somebody else is joining the
   * same team. `groupbuy_members_leader_uq` is partial on `role = 'leader' AND
   * status = 'joined'`, so two leaders is not a bug that can be argued about:
   * it is a unique-violation and one of the two transactions dies.
   *
   * The assertion is therefore both halves — no crash, and exactly one leader.
   */
  it('passes to exactly one heir while a join is in flight', async () => {
    for (let round = 0; round < 6; round += 1) {
      await harness.db.truncateAll();
      harness.clock.set(NOW);

      const fixture = await makeActivity({ seatsRequired: 4, stock: 10 });
      const [leader, heir, latecomer] = await makeUsers(3);
      const opened = await placeOrder(racer(leader!), { userId: leader!, fixture });
      const second = await placeOrder(racer(heir!), {
        userId: heir!,
        fixture,
        groupId: opened.groupId,
      });
      await pay(racer(leader!), opened.orderId);
      await pay(racer(heir!), second.orderId);

      const report = await runConcurrently(2, async (index) => {
        if (index === 0) await refund(racer(leader!), opened.orderId);
        else
          await placeOrder(racer(latecomer!), {
            userId: latecomer!,
            fixture,
            groupId: opened.groupId,
          });
        return true;
      });
      expect(report.rejected).toEqual([]);

      const rows = await members(opened.groupId);
      const leaders = rows.filter((row) => row.role === 'leader' && row.status === 'joined');
      expect(leaders).toHaveLength(1);
      expect(leaders[0]!.userId).toBe(heir);

      const group = await readGroup(opened.groupId);
      expect(group.leaderUserId).toBe(heir);
      expect(group.seatsTaken).toBe(1);
      expect(group.status).toBe('forming');
    }
  });

  /**
   * Two paid members refund at the same instant and both look for an heir. The
   * team must end with one leader, or — if they were the only two — as a failed
   * team with none of them left holding a seat.
   */
  it('survives two members refunding at once', async () => {
    const fixture = await makeActivity({ seatsRequired: 4, stock: 10 });
    const users = await makeUsers(3);
    const opened = await placeOrder(racer(users[0]!), { userId: users[0]!, fixture });
    const placed = [{ userId: users[0]!, ...opened }];
    for (const userId of users.slice(1)) {
      placed.push({
        userId,
        ...(await placeOrder(racer(userId), { userId, fixture, groupId: opened.groupId })),
      });
    }
    for (const entry of placed) await pay(racer(entry.userId), entry.orderId);

    // The leader and the first member walk; the third stays.
    const report = await runConcurrently(2, async (index) => {
      const entry = placed[index]!;
      await refund(racer(entry.userId), entry.orderId);
      return true;
    });
    expect(report.rejected).toEqual([]);

    const rows = await members(opened.groupId);
    expect(rows.filter((row) => row.role === 'leader' && row.status === 'joined')).toHaveLength(1);
    expect(await readGroup(opened.groupId)).toMatchObject({
      status: 'forming',
      seatsTaken: 1,
      leaderUserId: users[2],
    });
    expect(await readLedgers(fixture)).toEqual({
      activity: { stock: 9, sales: 1 },
      sku: { stock: 9, sales: 1 },
    });
  });
});

describe('a join into a team that fails a moment before', () => {
  /** `beforeCreate` passes on a forming team; the team's fate moves; then `afterCreate`. */
  async function joinAcross(
    ctx: Ctx,
    args: { userId: number; fixture: ActivityFixture; groupId: number },
    between: () => Promise<void>,
  ): Promise<number> {
    const orderId = await makeOrder(ctx, args.userId, args.fixture);
    await withTx(ctx.db, async (tx) => {
      const meta = await groupbuyKindHandler.beforeCreate(ctx, tx, {
        userId: args.userId,
        lines: [
          {
            skuId: args.fixture.skuId,
            productId: args.fixture.productId,
            quantity: 1,
            unitPrice: Money.parse(PRICE),
            subtotal: Money.parse(PRICE),
          },
        ],
        goodsTotal: Money.parse(PRICE),
        selections: {
          activityId: String(args.fixture.activityId),
          groupId: String(args.groupId),
        },
      } as never);
      await between();
      await groupbuyKindHandler.afterCreate(ctx, tx, orderId, meta);
    });
    return orderId;
  }

  it('is refused under the group lock, and reserves nothing', async () => {
    const fixture = await makeActivity({ seatsRequired: 3, stock: 10, ttlSeconds: 3_600 });
    const [leader, latecomer] = await makeUsers(2);
    const opened = await placeOrder(racer(leader!), { userId: leader!, fixture });
    await pay(racer(leader!), opened.orderId);
    const before = await readLedgers(fixture);

    // The team expires and is settled as failed after the join's first half.
    const join = joinAcross(
      racer(latecomer!),
      { userId: latecomer!, fixture, groupId: opened.groupId },
      async () => {
        harness.clock.set('2026-06-01T02:00:00.000Z');
        await settleGroup(forkTestCtx(harness), opened.groupId);
        harness.clock.set(NOW);
      },
    );

    await expect(join).rejects.toMatchObject({ code: 'GROUPBUY_GROUP_NOT_JOINABLE' });
    expect(await readGroup(opened.groupId)).toMatchObject({ status: 'failed' });
    const rows = await members(opened.groupId);
    expect(rows.map((row) => row.userId)).toEqual([leader]);
    expect(await readLedgers(fixture)).toEqual(before);
  });

  it('queues behind a transaction holding the team, then sees what it decided', async () => {
    const fixture = await makeActivity({ seatsRequired: 3, stock: 10 });
    const [leader, latecomer] = await makeUsers(2);
    const opened = await placeOrder(racer(leader!), { userId: leader!, fixture });
    const before = await readLedgers(fixture);

    // Another transaction holds the group row, as a settle or a refund does,
    // and fails the team. The join's second half must queue behind it and
    // then refuse, not act on the `forming` it read before the lock.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const holder = withTx(forkTestCtx(harness).db, async (tx) => {
      await tx
        .select()
        .from(groupbuyGroups)
        .where(eq(groupbuyGroups.id, opened.groupId))
        .for('update');
      locked();
      await released;
      await tx
        .update(groupbuyGroups)
        .set({ status: 'failed' })
        .where(eq(groupbuyGroups.id, opened.groupId));
    });

    const join = joinAcross(
      racer(latecomer!),
      { userId: latecomer!, fixture, groupId: opened.groupId },
      async () => {
        await holding;
        // The join reaches the lock and waits there before the holder decides.
        setTimeout(release, 200);
      },
    );

    // The refusal is observed before waiting on the holder: the join can reject
    // in the same turn the holder commits, and an unobserved rejection fails
    // the run even though the assertion below would have passed.
    const refused = expect(join).rejects.toMatchObject({ code: 'GROUPBUY_GROUP_NOT_JOINABLE' });
    await holder;
    await refused;
    const rows = await members(opened.groupId);
    expect(rows.map((row) => row.userId)).toEqual([leader]);
    expect(await readLedgers(fixture)).toEqual(before);
  });
});

describe('one shopper, two clicks', () => {
  /**
   * Reading the membership and then inserting would let a shopper who
   * double-tapped 参团 join the same team twice and pay twice.
   * `groupbuy_members_group_user_uq` makes that a 23505, which the kind handler
   * turns into a 409.
   */
  it('joins the same team once', async () => {
    const fixture = await makeActivity({ seatsRequired: 4, stock: 20 });
    const [leader, eager] = await makeUsers(2);
    const opened = await placeOrder(racer(leader!), { userId: leader!, fixture });

    const report = await runConcurrently(4, async () => {
      try {
        await placeOrder(racer(eager!), { userId: eager!, fixture, groupId: opened.groupId });
        return true;
      } catch {
        return false;
      }
    });

    expect(report.winners).toBe(1);
    const rows = await members(opened.groupId);
    expect(rows.filter((row) => row.userId === eager)).toHaveLength(1);
  });
});
