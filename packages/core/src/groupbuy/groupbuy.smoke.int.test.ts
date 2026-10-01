import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { groupbuyErrors } from '@shop/contracts/groupbuy/errors';
import { groupbuyPoster } from '@shop/contracts/groupbuy/schemas';
import { products, productSkus } from '@shop/db/schema/catalog';
import { groupbuyActivities, groupbuyActivitySkus, groupbuyGroups } from '@shop/db/schema/groupbuy';
import { attachments } from '@shop/db/schema/storage';
import { effects } from '@shop/db/schema/system';
import { userAddresses, users } from '@shop/db/schema/user';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { registerCatalogDomain } from '../catalog';
import { registerShippingFreightPort } from '../shipping';
import { drainEffects } from '../effects';
import type { Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { Money } from '../kernel/money';
import { withTx } from '../kernel/tx';
import * as checkout from '../order';
import { onOrderPaid, registerOrderStateMachine, resetOrderPorts } from '../order/ports';
import { groupbuyConfig } from './groupbuy.config';
import { clearAutoRefundPort } from './groupbuy.effects';
import { settleExpiredGroups, settleGroup } from './groupbuy.jobs';
import * as repo from './groupbuy.repo';
import * as service from './groupbuy.service';
import { registerGroupbuyDomain } from './index';

/**
 * Two smoke rows, over teams opened and joined through the real checkout and
 * paid through the order state machine and its paid hooks, as the payment
 * callback does.
 *
 * SMOKE-009 — the group-buy poster, offline. The server answers the poster's
 * *data* and the client draws it (`groupbuy.service.ts` › `poster`), so the
 * proof is that it needs nothing outside: nothing is pre-seeded, every outbound
 * `fetch` throws, no WeChat credential is configured — and the poster still
 * comes back whole, writes no attachment, and an unknown team is the contract's
 * 404.
 *
 * SMOKE-012 — a team succeeds once. Success is one conditional update of the
 * team row (`succeedGroup`), which every member — leader included — reads their
 * status from, and the "notification" is the `groupbuy.settle` effect.
 * Everything that could complete the team a second time is run after it filled:
 * its own expiry timer, the sweep, and an operator's 立即成团.
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
  await harness.ctx.config.invalidate(groupbuyConfig.group);
  harness.clock.set(NOW);
  resetOrderPorts();
  clearAutoRefundPort();
  registerGroupbuyDomain();
  registerCatalogDomain();
  registerShippingFreightPort();
  registerOrderStateMachine(checkout.orderStateMachine);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetOrderPorts();
  clearAutoRefundPort();
});

let sequence = 0;

const asUser = (id: number): Ctx =>
  harness.as({ kind: 'user', id, permissions: [], isSuper: false });

async function makeShopper(nickname: string): Promise<number> {
  sequence += 1;
  const [row] = await harness.ctx.db
    .insert(users)
    .values({
      account: `poster-${sequence}`,
      nickname,
      avatarUrl: `https://example.test/u/${sequence}.png`,
    })
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

/** A three-seat 拼团 at ¥59 on an ¥88 SKU. */
async function makeActivity(): Promise<{ activityId: number; skuId: number }> {
  sequence += 1;
  const [product] = await harness.ctx.db
    .insert(products)
    .values({
      name: `坚果礼盒${sequence}`,
      imageUrl: 'https://example.test/p.png',
      status: 'on_shelf',
      freightMode: 'free',
      price: '88.00',
      stock: 100,
    })
    .returning({ id: products.id });
  const [sku] = await harness.ctx.db
    .insert(productSkus)
    .values({
      productId: product!.id,
      skuCode: `SKU-${sequence}`,
      specText: '混合装',
      price: '88.00',
      stock: 100,
    })
    .returning({ id: productSkus.id });
  const [activity] = await harness.ctx.db
    .insert(groupbuyActivities)
    .values({
      productId: product!.id,
      title: '三人成团 · 坚果礼盒',
      imageUrl: 'https://example.test/a.png',
      status: 'active',
      price: '59.00',
      originalPrice: '88.00',
      seatsRequired: 3,
      groupTtlSeconds: 86_400,
      stock: 10,
      perOrderQuantity: 2,
      startAt: new Date('2026-05-01T00:00:00.000Z'),
      endAt: new Date('2026-07-01T00:00:00.000Z'),
    })
    .returning({ id: groupbuyActivities.id });
  await harness.ctx.db.insert(groupbuyActivitySkus).values({
    activityId: activity!.id,
    skuId: sku!.id,
    price: '59.00',
    stock: 10,
    isEnabled: true,
  });
  return { activityId: activity!.id, skuId: sku!.id };
}

/** A real group-buy checkout — 开团 without `groupId`, 参团 with one — then paid. */
async function buyIntoTeam(
  userId: number,
  activity: { activityId: number; skuId: number },
  groupId?: number,
): Promise<{ orderId: number; groupId: number }> {
  sequence += 1;
  const created = await checkout.create(asUser(userId), {
    source: 'buy-now',
    cartItemIds: [],
    item: { skuId: String(activity.skuId), quantity: 1 },
    kind: 'groupbuy',
    kindMeta: {
      activityId: String(activity.activityId),
      ...(groupId === undefined ? {} : { groupId: String(groupId) }),
    },
    idempotencyKey: `smoke-gb-${sequence.toString().padStart(8, '0')}`,
  });
  const orderId = Number(created.id);
  await withTx(harness.ctx.db, async (tx) => {
    const at = harness.ctx.clock.now();
    const moved = await checkout.orderStateMachine.transition(
      tx,
      orderId,
      ['pending_payment'],
      'paid',
      { at, paidAmount: created.payableAmount, transactionNo: `WX-${orderId}` },
    );
    if (!moved.won) throw new Error('could not mark the order paid');
    await onOrderPaid.dispatch(tx, harness.ctx, {
      orderId,
      orderNo: created.orderNo,
      userId,
      paidAmount: Money.parse(created.payableAmount),
      at,
      transactionId: `WX-${orderId}`,
    });
  });
  const member = await repo.findMemberByOrder(harness.ctx.db, orderId);
  expect(member, 'the paid order is in no team').not.toBeNull();
  return { orderId, groupId: member!.groupId };
}

/** 开团 on a fresh activity. Answers the team. */
async function openTeam(leaderId: number): Promise<number> {
  return (await buyIntoTeam(leaderId, await makeActivity())).groupId;
}

/** Every outbound request fails the test: WeChat, a CDN, anything. */
function forbidNetwork(): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async (input: unknown) => {
    throw new Error(`SMOKE-009: the poster made a network call to ${String(input)}`);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('SMOKE-009 — the group-buy poster, offline', () => {
  it('answers the whole poster with no network, no WeChat and no upload', async () => {
    const leaderId = await makeShopper('小明');
    const groupId = await openTeam(leaderId);
    const fetch = forbidNetwork();

    const poster = await service.poster(asUser(leaderId), { id: String(groupId) });

    // The contract's own shape, every field the client draws from.
    expect(groupbuyPoster.parse(poster)).toEqual(poster);
    expect(poster).toMatchObject({
      groupId: String(groupId),
      title: '三人成团 · 坚果礼盒',
      imageUrl: 'https://example.test/a.png',
      price: '59.00',
      originalPrice: '88.00',
      seatsLeft: 2,
      leaderNickname: '小*',
    });
    expect(poster.leaderAvatarUrl).toMatch(/^https:\/\/example\.test\/u\/\d+\.png$/);
    // The QR code is a string the client encodes, not an image anybody fetched.
    expect(poster.qrPayload).toContain(String(groupId));
    expect(poster.page).toBe(poster.qrPayload);

    expect(fetch).not.toHaveBeenCalled();
    expect(await harness.ctx.db.select().from(attachments)).toEqual([]);
  });

  it('answers a second shopper the same poster, still without an upload', async () => {
    const leaderId = await makeShopper('小明');
    const groupId = await openTeam(leaderId);
    const friend = await makeShopper('小红');
    forbidNetwork();

    const first = await service.poster(asUser(leaderId), { id: String(groupId) });
    const second = await service.poster(asUser(friend), { id: String(groupId) });

    expect(second).toEqual(first);
    // An attachment per poster would be a cache nothing sweeps.
    expect(await harness.ctx.db.select().from(attachments)).toEqual([]);
  });

  it('answers an unknown team with the contract’s 404, not a 500', async () => {
    const shopper = await makeShopper('小明');
    forbidNetwork();

    const error = await service.poster(asUser(shopper), { id: '999999' }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('GROUPBUY_GROUP_NOT_FOUND');
    expect(groupbuyErrors.GROUPBUY_GROUP_NOT_FOUND.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// SMOKE-012
// ---------------------------------------------------------------------------

const readTeam = async (groupId: number) =>
  (await harness.ctx.db.select().from(groupbuyGroups).where(eq(groupbuyGroups.id, groupId)))[0]!;

async function effectsOf(scope: string, scopeId: string, eventType: string) {
  return harness.ctx.db
    .select()
    .from(effects)
    .where(
      and(eq(effects.scope, scope), eq(effects.scopeId, scopeId), eq(effects.eventType, eventType)),
    );
}

describe('SMOKE-012 — a team succeeds once, and says so once', () => {
  it('completes leader and members together, and nothing completes it again', async () => {
    const activity = await makeActivity();
    const leader = await makeShopper('团长');
    const opened = await buyIntoTeam(leader, activity);
    const members = [await makeShopper('团员甲'), await makeShopper('团员乙')];
    const joined: { orderId: number; groupId: number }[] = [];
    for (const member of members) joined.push(await buyIntoTeam(member, activity, opened.groupId));
    const groupId = opened.groupId;

    const team = await readTeam(groupId);
    expect(team).toMatchObject({ status: 'succeeded', seatsTaken: 3, seatsTotal: 3 });
    const succeededAt = team.succeededAt;
    expect(succeededAt).toBeInstanceOf(Date);

    // Leader and members read the same outcome, each for their own order.
    const everyone = [
      { userId: leader, orderId: opened.orderId, role: 'leader' },
      ...members.map((userId, index) => ({
        userId,
        orderId: joined[index]!.orderId,
        role: 'member',
      })),
    ];
    for (const person of everyone) {
      const mine = await service.myGroups(asUser(person.userId), { page: 1, pageSize: 20 });
      expect(mine.items).toEqual([
        expect.objectContaining({
          groupId: String(groupId),
          status: 'succeeded',
          role: person.role,
          memberStatus: 'joined',
          orderId: String(person.orderId),
          seatsTaken: 3,
        }),
      ]);
    }

    // Everything that could complete it a second time: the team's own expiry
    // timer (its effect, drained), the sweep, a direct settle, and 立即成团.
    harness.clock.set(new Date(Date.parse(NOW) + 2 * 86_400_000).toISOString());
    await drainEffects(harness.ctx, { baseBackoffMs: 0, maxBackoffMs: 0 });
    expect(await settleGroup(harness.ctx, groupId)).toMatchObject({ outcome: 'unchanged' });
    await settleExpiredGroups(harness.ctx);
    await drainEffects(harness.ctx, { baseBackoffMs: 0, maxBackoffMs: 0 });
    const operator = harness.as({
      kind: 'admin',
      id: 1,
      permissions: ['groupbuy:group:complete'],
      isSuper: true,
    });
    const refused = await service
      .adminGroupComplete(operator, { id: String(groupId) }, { reason: 'SMOKE-012' })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect((refused as DomainError | null)?.code).toBe('GROUPBUY_GROUP_NOT_COMPLETABLE');

    // Moved once: same status, same timestamp, same seats.
    expect(await readTeam(groupId)).toMatchObject({
      status: 'succeeded',
      seatsTaken: 3,
      succeededAt,
    });
    // Said once: one settle notice for the team, one join notice per order,
    // and every one of them delivered rather than retrying.
    const settled = await effectsOf('groupbuy', String(groupId), 'groupbuy.settle');
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload).toMatchObject({ outcome: 'succeeded', virtual: false });
    for (const person of everyone) {
      expect(await effectsOf('order', String(person.orderId), 'groupbuy.join')).toHaveLength(1);
    }
    const notices = [
      ...settled,
      ...(
        await Promise.all(
          everyone.map((person) => effectsOf('order', String(person.orderId), 'groupbuy.join')),
        )
      ).flat(),
    ];
    expect(notices.map((row) => row.status)).toEqual(notices.map(() => 'done'));
    // Nobody is refunded out of a team that succeeded.
    expect(
      (
        await Promise.all(
          everyone.map((person) => effectsOf('order', String(person.orderId), 'groupbuy.refund')),
        )
      ).flat(),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 立即成团
// ---------------------------------------------------------------------------

/**
 * 立即成团 never invents members (虚拟成团 is off for good, 2026-09-23). An
 * operator pressing it on an under-filled team is refused and records nothing,
 * and the team settles at its deadline like any other: it fails, and the
 * failure is the one `groupbuy.settle` it ever records.
 */
describe('立即成团 says so', () => {
  it('RISK-D-006 — refuses an under-filled team and records no groupbuy.settle', async () => {
    const leader = await makeShopper('团长');
    const groupId = await openTeam(leader);
    const operator = harness.as({
      kind: 'admin',
      id: 1,
      permissions: ['groupbuy:group:complete'],
      isSuper: true,
    });

    const refused = await service.adminGroupComplete(operator, { id: String(groupId) }, {}).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect((refused as DomainError | null)?.code).toBe('GROUPBUY_VIRTUAL_FILL_DISABLED');
    expect(await readTeam(groupId)).toMatchObject({ status: 'forming' });
    expect(await effectsOf('groupbuy', String(groupId), 'groupbuy.settle')).toEqual([]);

    harness.clock.set(new Date(Date.parse(NOW) + 2 * 86_400_000).toISOString());
    await settleExpiredGroups(harness.ctx);
    await drainEffects(harness.ctx, { baseBackoffMs: 0, maxBackoffMs: 0 });

    expect(await readTeam(groupId)).toMatchObject({ status: 'failed' });
    const settled = await effectsOf('groupbuy', String(groupId), 'groupbuy.settle');
    expect(settled).toHaveLength(1);
    expect(settled[0]!.payload).toMatchObject({ outcome: 'failed', virtual: false });
  });
});
