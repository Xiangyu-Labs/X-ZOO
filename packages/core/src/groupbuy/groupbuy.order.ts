import type { Tx } from '@shop/db';
import type { Ctx } from '../kernel/context';
import { DomainError, validationFailed } from '../kernel/errors';
import { Money } from '../kernel/money';
import { recordEffect } from '../effects/index';
import {
  onOrderCancelled,
  onOrderPaid,
  onOrderRefunded,
  registerOrderKindHandler,
  registerPricingContributor,
  type OrderKindHandler,
  type PriceAdjustment,
  type PricingContributor,
  type PricingDraft,
} from '../order/ports';
import * as repo from './groupbuy.repo';
import {
  assertActivityDiscountApplied,
  assertActivityOpen,
  assertActivityPriceApplied,
  assertGroupJoinable,
  assertQuantityAllowed,
  expectedGoodsTotal,
  groupExpiresAt,
} from './groupbuy.rules';

/**
 * Where the group-buy domain attaches to an order.
 *
 * There is no "join a group" endpoint. Joining *is* placing an order, so the
 * storefront calls the order domain's `POST /api/v1/orders` with
 * `kind: 'groupbuy'` and `kindMeta: { activityId, groupId? }`, and everything
 * here hangs off the seams in `order/ports.ts`. A second checkout path would be
 * a second copy of stock, coupons, freight and idempotency, and two copies
 * drift apart on stock.
 *
 * The one rule that decides the whole design: **a seat is taken when the order
 * is paid, not when it is placed.** An unpaid order holds activity stock (so a
 * campaign cannot be oversold by people who never pay) but holds no seat (so a
 * team is never blocked by somebody who wandered off).
 */

const KIND = 'groupbuy';

/** The contributor's name, used both to register it and to check it fired. */
const PRICING_SOURCE = 'groupbuy:activity-price';

interface KindMeta {
  activityId: number;
  groupId: number | null;
  userId: number;
  quantity: number;
  lines: { skuId: number; quantity: number }[];
  seatsRequired: number;
  groupTtlSeconds: number;
  /** What the活动 says these lines cost; checked against the written order. */
  expectedGoodsTotal: string;
}

function readMeta(meta: Record<string, unknown>): KindMeta {
  return meta as unknown as KindMeta;
}

function readSelection(draft: PricingDraft, key: string): number | null {
  const raw = draft.selections[key];
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw validationFailed({ field: key, value: raw });
  }
  return value;
}

// ---------------------------------------------------------------------------
// the kind handler
// ---------------------------------------------------------------------------

export const groupbuyKindHandler: OrderKindHandler = {
  kind: KIND,

  /**
   * Everything that can refuse the order, before a row exists.
   *
   * The activity's own price is computed here and carried in the meta for
   * `afterCreate` to check against the written lines. `draft.goodsTotal` is the
   * sum of the line subtotals before any adjustment, so it is the *catalogue*
   * price even on a correctly priced group-buy order and comparing the two
   * directly would refuse every order.
   *
   * What can be checked here is the adjustment itself: the draft carries the
   * applied adjustments, so this asks whether this domain's contributor took
   * off exactly the gap it owes. Cheap, and it fails before a row exists.
   */
  async beforeCreate(ctx: Ctx, tx: Tx, draft: PricingDraft): Promise<Record<string, unknown>> {
    const activityId = readSelection(draft, 'activityId');
    if (activityId === null) throw validationFailed({ field: 'kindMeta.activityId' });
    const groupId = readSelection(draft, 'groupId');
    const now = ctx.clock.now();

    const activity = await repo.findActivity(tx, activityId);
    if (!activity) throw new DomainError('GROUPBUY_ACTIVITY_NOT_FOUND');
    assertActivityOpen(activity, now);

    const quantity = draft.lines.reduce((sum, line) => sum + line.quantity, 0);
    assertQuantityAllowed(activity, quantity);

    const skus = await repo.listActivitySkus(tx, [activityId]);
    const prices = new Map(skus.filter((s) => s.isEnabled).map((s) => [s.skuId, s.price]));
    const lines = draft.lines.map((line) => ({ skuId: line.skuId, quantity: line.quantity }));
    // Refuses a line that is not part of the activity at all, here, where there
    // is still nothing to roll back.
    const expected = expectedGoodsTotal(lines, prices);

    const mine = draft.adjustments?.find((adjustment) => adjustment.source === PRICING_SOURCE);
    assertActivityDiscountApplied({
      // Negative: what the campaign owes the shopper off the catalogue price.
      expected: expected.sub(draft.goodsTotal),
      actual: mine?.amount ?? Money.ZERO,
      activityId,
    });

    if (groupId !== null) {
      const group = await repo.findGroup(tx, groupId);
      if (!group || group.activityId !== activityId) {
        throw new DomainError('GROUPBUY_GROUP_NOT_FOUND');
      }
      assertGroupJoinable(group, now);
      const existing = await repo.findMember(tx, { groupId, userId: draft.userId });
      if (existing) throw new DomainError('GROUPBUY_ALREADY_IN_GROUP');
    }

    const meta: KindMeta = {
      activityId,
      groupId,
      userId: draft.userId,
      quantity,
      lines,
      seatsRequired: activity.seatsRequired,
      groupTtlSeconds: activity.groupTtlSeconds,
      expectedGoodsTotal: expected.toString(),
    };
    return meta as unknown as Record<string, unknown>;
  },

  /**
   * Runs inside the order domain's transaction, right beside the catalog's SKU
   * reservation.
   *
   * Two things happen and neither is a seat: the activity's own stock ledger
   * comes down, and a membership row is written as a statement of *intent*.
   * The seat itself waits for the money.
   *
   * It also carries the fail-closed half of the activity-price guard: the
   * order's lines exist by now, so what they charge can be compared with what
   * the activity says they cost. Throwing rolls back the whole order
   * transaction — the order, its lines, the stock reservation — which is the
   * point.
   */
  async afterCreate(ctx: Ctx, tx: Tx, orderId: number, rawMeta: Record<string, unknown>) {
    const meta = readMeta(rawMeta);
    const now = ctx.clock.now();

    assertActivityPriceApplied({
      expected: Money.parse(meta.expectedGoodsTotal),
      charged: Money.parse(await repo.orderGoodsCharged(tx, orderId)),
      activityId: meta.activityId,
    });

    // Lock order: the group row first, the activity SKU row second, as
    // `handleRefunded` and `settleDeparture` take them. Otherwise the join
    // would take the SKU row here and the group row implicitly later, through
    // `groupbuy_members.group_id`'s foreign key (`FOR KEY SHARE`), and a
    // leader's refund on the same team — group first, SKU second — would
    // deadlock with it.
    //
    // Under the lock the team is re-read: `beforeCreate` checked it without
    // one, and it may have failed, been cancelled or filled since. The lock
    // makes this check exact — nothing changes the team until this
    // transaction ends.
    if (meta.groupId !== null) {
      const group = await repo.lockGroup(tx, meta.groupId);
      if (!group || group.activityId !== meta.activityId) {
        throw new DomainError('GROUPBUY_GROUP_NOT_FOUND');
      }
      assertGroupJoinable(group, now);
    }

    for (const line of meta.lines) {
      const reserved = await repo.reserveActivityStock(tx, {
        activityId: meta.activityId,
        skuId: line.skuId,
        quantity: line.quantity,
      });
      if (!reserved) {
        throw new DomainError('GROUPBUY_OUT_OF_STOCK', { details: { skuId: String(line.skuId) } });
      }
    }

    const identity = await repo.findUserIdentity(tx, meta.userId);
    let groupId = meta.groupId;
    let role: 'leader' | 'member' = 'member';

    if (groupId === null) {
      const group = await repo.insertGroup(tx, {
        activityId: meta.activityId,
        leaderUserId: meta.userId,
        seatsTotal: meta.seatsRequired,
        seatsTaken: 0,
        status: 'forming',
        expiresAt: groupExpiresAt(now, meta.groupTtlSeconds),
      });
      groupId = group.id;
      role = 'leader';

      // The team's own clock. An effect rather than a delayed queue job,
      // because this runs inside the order transaction and a queue is not
      // transactional: an enqueue here could be delivered before — or without —
      // the group row it names. `groupbuy.sweepExpiredGroups` is the backstop.
      await recordEffect(tx, ctx, {
        scope: 'groupbuy',
        scopeId: String(groupId),
        eventType: 'groupbuy.expire',
        payload: { groupId: String(groupId) },
        delayMs: meta.groupTtlSeconds * 1_000,
      });
    }

    try {
      await repo.insertMember(tx, {
        groupId,
        userId: meta.userId,
        orderId,
        role,
        status: 'joined',
        nickname: identity?.nickname ?? null,
        avatarUrl: identity?.avatarUrl ?? null,
        quantity: meta.quantity,
      });
    } catch (error) {
      // `groupbuy_members_group_user_uq` is the "already in this team" check,
      // made by the database so it cannot race. Two simultaneous joins by the
      // same shopper both reach here; one of them gets a 23505 and a 409.
      if (repo.isUniqueViolation(error)) throw new DomainError('GROUPBUY_ALREADY_IN_GROUP');
      throw error;
    }
  },

  /**
   * 查看拼团 on the order detail: the team of the order's membership row. `afterCreate`
   * writes that row with the order (UNIQUE on `order_id`), so every group-buy order has one;
   * a cancel or refund changes its status, never its team.
   */
  async detailLinks(db, orderId) {
    const member = await repo.findMemberByOrder(db, orderId);
    return { groupbuyTeamId: member?.groupId ?? null };
  },

  /**
   * RISK-D-011: nothing ships — by hand or by auto-delivery — until the team succeeded. A
   * team that fails refunds every member, and goods already on the road would be lost.
   */
  async readyToShip(db, orderId) {
    const [row] = await repo.listTeamsByOrders(db, [orderId]);
    return row === undefined || row.group.status === 'succeeded';
  },

  /** 拼团中 / 拼团成功 / 拼团失败 on 我的订单: the team of each order's seat. */
  async orderStates(db, orderIds) {
    const rows = await repo.listTeamsByOrders(db, orderIds);
    return new Map(
      rows.map((row) => [
        row.orderId,
        {
          groupbuyTeam: {
            id: row.group.id,
            status: row.group.status,
            role: row.role,
            seatsTotal: row.group.seatsTotal,
            seatsTaken: row.group.seatsTaken,
            expiresAt: row.group.expiresAt,
          },
        },
      ]),
    );
  },

  /**
   * The activity's own 运费模板, which charges the order in place of the
   * product's freight setting; `null` (the form's 留空) follows the product.
   */
  async freightTemplateId(db, selections) {
    const activityId = Number(selections['activityId']);
    if (!Number.isInteger(activityId) || activityId <= 0) return null;
    return (await repo.findActivity(db, activityId))?.shippingTemplateId ?? null;
  },
};

// ---------------------------------------------------------------------------
// the pricing contributor
// ---------------------------------------------------------------------------

/**
 * Replaces the catalogue price with the activity price.
 *
 * Priority 50 — before coupons (100), because a coupon's 满减 threshold should
 * be judged against what the shopper actually pays.
 *
 * It fires on `kind === 'groupbuy'` alone, which the order domain puts into
 * `selections` alongside every `kindMeta` key. An ordinary order naming the
 * same SKU keeps the catalogue price, and `assertActivityPriceApplied` in
 * `afterCreate` refuses any group-buy order this did not reach.
 */
export const groupbuyPricingContributor: PricingContributor = {
  name: PRICING_SOURCE,
  priority: 50,

  async contribute(ctx: Ctx, draft: PricingDraft): Promise<PriceAdjustment[]> {
    if (draft.selections['kind'] !== KIND) return [];
    const raw = draft.selections['activityId'];
    if (!raw) return [];
    const activityId = Number(raw);
    if (!Number.isInteger(activityId) || activityId <= 0) return [];

    const activity = await repo.findActivity(ctx.db, activityId);
    if (!activity || !isOpenNow(ctx, activity)) return [];

    const skus = await repo.listActivitySkus(ctx.db, [activityId]);
    const prices = new Map(skus.filter((s) => s.isEnabled).map((s) => [s.skuId, s.price]));

    const perLine: Money[] = [];
    for (const line of draft.lines) {
      const price = prices.get(line.skuId);
      // A line outside the activity keeps its ordinary price. `beforeCreate`
      // is the one that refuses the order; a contributor never throws, because
      // it also runs on the preview a shopper is merely looking at.
      if (price === undefined) {
        perLine.push(Money.ZERO);
        continue;
      }
      perLine.push(Money.parse(price).mul(line.quantity).sub(line.subtotal));
    }

    const amount = Money.sum(perLine);
    if (amount.isZero()) return [];
    return [
      {
        source: PRICING_SOURCE,
        label: `拼团价（${activity.title}）`,
        amount,
        perLine,
      },
    ];
  },
};

function isOpenNow(ctx: Ctx, activity: repo.ActivityRow): boolean {
  const now = ctx.clock.now();
  return (
    activity.status === 'active' &&
    activity.deletedAt === null &&
    activity.startAt.getTime() <= now.getTime() &&
    activity.endAt.getTime() > now.getTime()
  );
}

// ---------------------------------------------------------------------------
// lifecycle hooks
// ---------------------------------------------------------------------------

/**
 * The money arrived. Take the seat — in one conditional `UPDATE` that carries
 * "still forming", "not expired" and "not full" in its `WHERE`.
 *
 * Losing that statement is not an error: it means the team filled or died while
 * this payment was in flight. The money is already ours, so the order is not
 * rolled back; the membership is marked refunded, the activity stock goes back,
 * and a `groupbuy.refund` effect asks for the money back after commit. Counting
 * rows before inserting instead would let two simultaneous last joins both
 * succeed, producing a four-person three-person team.
 */
async function handlePaid(
  tx: Tx,
  ctx: Ctx,
  event: { orderId: number; userId: number; at: Date },
): Promise<void> {
  const member = await repo.findMemberByOrder(tx, event.orderId);
  if (!member || member.status !== 'joined') return;
  const now = event.at;

  const seat = await repo.takeSeat(tx, { groupId: member.groupId, now });

  if (!seat.won) {
    await abandonSeat(tx, ctx, {
      orderId: event.orderId,
      groupId: member.groupId,
      now,
      reason: 'seat_lost',
    });
    return;
  }

  // The reservation becomes a sale on the activity's ledger, mirroring what the
  // catalog's `StockPort.commit` just did on the SKU's. It can still be
  // refused: `total_quota` is a ceiling on sales, and sales are counted here.
  const sold = await commitOrderLines(tx, event.orderId);
  if (!sold) {
    await repo.freeSeat(tx, { groupId: member.groupId, now });
    await abandonSeat(tx, ctx, {
      orderId: event.orderId,
      groupId: member.groupId,
      now,
      reason: 'quota_reached',
    });
    return;
  }

  await recordEffect(tx, ctx, {
    scope: 'order',
    scopeId: String(event.orderId),
    eventType: 'groupbuy.join',
    // The role as it was when the seat was taken: a member promoted later, when
    // the leader left, still joined somebody else's team.
    payload: {
      orderId: String(event.orderId),
      groupId: String(member.groupId),
      role: member.role,
    },
  });

  // The last seat completes the team in this same transaction. `succeedGroup`
  // carries `seats_taken = seats_total` in its `WHERE`, so if somebody else got
  // there first this is a no-op rather than a CHECK violation.
  const completed = await repo.succeedGroup(tx, { groupId: member.groupId, now });
  if (completed.won) {
    await recordEffect(tx, ctx, {
      scope: 'groupbuy',
      scopeId: String(member.groupId),
      eventType: 'groupbuy.settle',
      payload: { groupId: String(member.groupId), outcome: 'succeeded', virtual: false },
    });
  }
}

/**
 * The money arrived but the team could not use it: the seat went to somebody
 * else, or the campaign's quota filled while the payment was in flight.
 *
 * The shopper leaves the team, the activity stock goes back, the money is asked
 * for, and — because the departing member may have been the leader — the team
 * gets an heir. The group is locked before the membership is touched, which is
 * the lock order every departure in this file follows.
 */
async function abandonSeat(
  tx: Tx,
  ctx: Ctx,
  args: {
    orderId: number;
    groupId: number;
    now: Date;
    reason: 'seat_lost' | 'quota_reached';
  },
): Promise<void> {
  const group = await repo.lockGroup(tx, args.groupId);
  const member = await repo.findMemberByOrder(tx, args.orderId);
  if (!member || member.status !== 'joined') return;

  await repo.leaveMember(tx, { memberId: member.id, status: 'refunded', now: args.now });
  await releaseOrderLines(tx, args.orderId, { soldToo: false });
  await requestAutoRefund(tx, ctx, {
    orderId: args.orderId,
    groupId: args.groupId,
    reason: args.reason,
  });
  await settleDeparture(tx, ctx, {
    member,
    now: args.now,
    paidOnly: true,
    seatsHeld: group?.seatsTaken ?? 0,
  });
}

/**
 * The order died before it was paid, so there is no seat to give back and no
 * money to return: only the activity stock and the membership.
 */
async function handleCancelled(
  tx: Tx,
  ctx: Ctx,
  event: { orderId: number; at: Date },
): Promise<void> {
  const found = await repo.findMemberByOrder(tx, event.orderId);
  if (!found || found.status !== 'joined') return;
  const now = event.at;

  // Lock order: the group row first, member rows after — see `handleRefunded`.
  await repo.lockGroup(tx, found.groupId);
  const member = await repo.findMemberByOrder(tx, event.orderId);
  if (!member || member.status !== 'joined') return;

  await repo.leaveMember(tx, { memberId: member.id, status: 'cancelled', now });
  await releaseOrderLines(tx, event.orderId, { soldToo: false });
  await settleDeparture(tx, ctx, { member, now, paidOnly: false });
}

/**
 * A full refund. A partial one changes nothing here: the shopper is still in
 * the team, they just got some money back for one line.
 *
 * The seat only comes back if the team is still forming. A **succeeded** team
 * keeps its `seats_taken`, because `groupbuy_groups_succeeded_is_full` says a
 * completed group is exactly full and because it is true: the team did
 * complete, and one member refunding afterwards does not un-complete it.
 */
async function handleRefunded(
  tx: Tx,
  ctx: Ctx,
  event: { orderId: number; at: Date; partial: boolean },
): Promise<void> {
  if (event.partial) return;
  const found = await repo.findMemberByOrder(tx, event.orderId);
  if (!found || found.status !== 'joined') return;
  const now = event.at;

  // Lock order matters here and is the reason the group is locked *before* the
  // membership is touched: two members of the same team refunding at the same
  // instant both want the group row and each other's member row. Taking the
  // group first everywhere turns that cycle into a queue. Everything is then
  // re-read under the lock, because the first caller through may already have
  // done this shopper's departure.
  const group = await repo.lockGroup(tx, found.groupId);
  const member = await repo.findMemberByOrder(tx, event.orderId);
  if (!member || member.status !== 'joined') return;

  await repo.leaveMember(tx, { memberId: member.id, status: 'refunded', now });
  await releaseOrderLines(tx, event.orderId, { soldToo: true });

  if (group?.status === 'forming') {
    await repo.freeSeat(tx, { groupId: member.groupId, now });
  }
  // The seat count *before* the refund decides the team's fate: a team that
  // once held a seat and is now empty has failed, it was not "never used".
  await settleDeparture(tx, ctx, {
    member,
    now,
    paidOnly: true,
    seatsHeld: group?.seatsTaken ?? 0,
  });
}

/**
 * Leadership and the team's fate after somebody leaves.
 *
 * `groupbuy_members_leader_uq` is partial on `role = 'leader' AND status =
 * 'joined'`, so the departing leader's row releases the slot the moment its
 * status changes — no demotion `UPDATE` is needed and the row keeps saying who
 * opened the team, which is the truth.
 *
 * The group is locked first so that a promotion and a concurrent join cannot
 * interleave into two leaders or none.
 */
async function settleDeparture(
  tx: Tx,
  ctx: Ctx,
  args: {
    member: { id: number; groupId: number; role: 'leader' | 'member' };
    now: Date;
    paidOnly: boolean;
    /** Seats the team held before this departure freed one. */
    seatsHeld?: number;
  },
): Promise<void> {
  const group = await repo.lockGroup(tx, args.member.groupId);
  if (!group) return;

  if (args.member.role === 'leader') {
    const heir = await repo.findSuccessorLocked(tx, {
      groupId: args.member.groupId,
      excludeMemberId: args.member.id,
      paidOnly: args.paidOnly,
    });
    if (heir) {
      await repo.promoteMember(tx, { memberId: heir.id, now: args.now });
      await repo.setGroupLeader(tx, {
        groupId: args.member.groupId,
        leaderUserId: heir.userId,
        now: args.now,
      });
    }
  }

  if (group.status !== 'forming') return;

  const left = await repo.countJoinedMembers(tx, args.member.groupId);
  if (left > 0) return;

  // Nobody is left. An empty team that never held a seat is cancelled; one that
  // did (everybody refunded) has failed.
  const seatsHeld = args.seatsHeld ?? group.seatsTaken;
  const closed =
    seatsHeld === 0
      ? await repo.cancelEmptyGroup(tx, { groupId: args.member.groupId, now: args.now })
      : await repo.failGroup(tx, { groupId: args.member.groupId, now: args.now });
  if (closed.won && seatsHeld > 0) {
    await recordEffect(tx, ctx, {
      scope: 'groupbuy',
      scopeId: String(args.member.groupId),
      eventType: 'groupbuy.settle',
      payload: { groupId: String(args.member.groupId), outcome: 'failed', virtual: false },
    });
  }
}

async function releaseOrderLines(
  tx: Tx,
  orderId: number,
  options: { soldToo: boolean },
): Promise<void> {
  const member = await repo.findMemberByOrder(tx, orderId);
  if (!member) return;
  const group = await repo.findGroup(tx, member.groupId);
  if (!group) return;
  for (const line of await repo.orderLines(tx, orderId)) {
    await repo.releaseActivityStock(tx, {
      activityId: group.activityId,
      skuId: line.skuId,
      quantity: line.quantity,
      soldToo: options.soldToo,
    });
  }
}

/** False when the campaign's quota refused the sale; see `commitActivitySales`. */
async function commitOrderLines(tx: Tx, orderId: number): Promise<boolean> {
  const member = await repo.findMemberByOrder(tx, orderId);
  if (!member) return true;
  const group = await repo.findGroup(tx, member.groupId);
  if (!group) return true;
  const lines = await repo.orderLines(tx, orderId);
  const sold: { skuId: number; quantity: number }[] = [];
  for (const line of lines) {
    const ok = await repo.commitActivitySales(tx, {
      activityId: group.activityId,
      skuId: line.skuId,
      quantity: line.quantity,
    });
    if (!ok) {
      // Put back the lines that did fit, so the order is all sold or none.
      for (const done of sold) {
        await repo.releaseActivitySales(tx, {
          activityId: group.activityId,
          skuId: done.skuId,
          quantity: done.quantity,
        });
      }
      return false;
    }
    sold.push({ skuId: line.skuId, quantity: line.quantity });
  }
  return true;
}

/**
 * Asks for a refund the shopper never requested.
 *
 * Recorded as an effect rather than called directly, so the gateway call
 * happens after commit. `UNIQUE (scope, scope_id, event_type)` makes it
 * exactly-once however many sweeps run, and a handler that keeps failing parks
 * the row in the payment domain's 待处理任务 console for a human.
 */
export async function requestAutoRefund(
  tx: Tx,
  ctx: Ctx,
  args: {
    orderId: number;
    groupId: number;
    reason: 'seat_lost' | 'group_failed' | 'quota_reached';
  },
): Promise<void> {
  await recordEffect(tx, ctx, {
    scope: 'order',
    scopeId: String(args.orderId),
    eventType: 'groupbuy.refund',
    payload: {
      orderId: String(args.orderId),
      groupId: String(args.groupId),
      reason: args.reason,
    },
  });
}

/**
 * Wires the seams. Idempotent: every registry replaces by name, so calling it
 * twice (a job module and the web bootstrap in the same process) is free, and
 * `resetOrderPorts()` in a test puts it back.
 */
export function registerGroupbuyOrderSeams(): void {
  registerOrderKindHandler(groupbuyKindHandler);
  registerPricingContributor(groupbuyPricingContributor);
  onOrderPaid.register('groupbuy:take-seat', (tx, ctx, event) => handlePaid(tx, ctx, event));
  onOrderCancelled.register('groupbuy:leave-team', (tx, ctx, event) =>
    handleCancelled(tx, ctx, event),
  );
  onOrderRefunded.register('groupbuy:refund-seat', (tx, ctx, event) =>
    handleRefunded(tx, ctx, event),
  );
}
