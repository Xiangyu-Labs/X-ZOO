import { DomainError } from '../kernel/errors';
import { Money } from '../kernel/money';

/**
 * The group-buy decisions that need no database.
 *
 * Everything here is a pure function of values already read, so it is unit
 * tested without PostgreSQL and the integration tests can spend their time on
 * the things that genuinely race — seats, stock and leadership.
 *
 * The rule that is *not* here is "may this shopper take the last seat". That
 * one cannot be a pure function: it is a conditional `UPDATE` in the repo, and
 * writing it as a check would be a read-then-write race (see
 * `docs/conventions.md`).
 */

export interface ActivityWindow {
  status: 'draft' | 'active' | 'paused' | 'ended';
  startAt: Date;
  endAt: Date;
  deletedAt?: Date | null;
}

/** Live for a shopper: published, not deleted, and inside its window. */
export function isActivityOpen(activity: ActivityWindow, now: Date): boolean {
  if (activity.deletedAt) return false;
  if (activity.status !== 'active') return false;
  return activity.startAt.getTime() <= now.getTime() && activity.endAt.getTime() > now.getTime();
}

export function assertActivityOpen(activity: ActivityWindow, now: Date): void {
  if (isActivityOpen(activity, now)) return;
  throw new DomainError('GROUPBUY_ACTIVITY_NOT_OPEN', {
    details: {
      status: activity.status,
      startAt: activity.startAt.toISOString(),
      endAt: activity.endAt.toISOString(),
      now: now.toISOString(),
    },
  });
}

/**
 * 每单限购份数.
 *
 * One function, so the ceiling cannot be checked with `>` in one place and `>=`
 * in another. `perOrderQuantity` is a ceiling on the whole order, not on each
 * line, because a group-buy order is one activity.
 */
export function assertQuantityAllowed(
  activity: { perOrderQuantity: number },
  quantity: number,
): void {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > activity.perOrderQuantity) {
    throw new DomainError('GROUPBUY_QUANTITY_NOT_ALLOWED', {
      details: { quantity, perOrderQuantity: activity.perOrderQuantity },
    });
  }
}

/** When a team opened now would give up. Stored, not recomputed, on the row. */
export function groupExpiresAt(now: Date, ttlSeconds: number): Date {
  return new Date(now.getTime() + ttlSeconds * 1000);
}

export interface GroupShape {
  status: 'forming' | 'succeeded' | 'failed' | 'cancelled';
  seatsTotal: number;
  seatsTaken: number;
  expiresAt: Date;
}

export function seatsLeft(group: GroupShape): number {
  return Math.max(0, group.seatsTotal - group.seatsTaken);
}

/**
 * Whether the storefront should *offer* this team.
 *
 * Advisory only. The seat is still taken by a conditional `UPDATE` when the
 * order is paid, and between this answer and that statement the team can fill —
 * which is exactly the race `takeSeat` is built to lose safely.
 */
export function isGroupJoinable(group: GroupShape, now: Date): boolean {
  return (
    group.status === 'forming' &&
    group.expiresAt.getTime() > now.getTime() &&
    group.seatsTaken < group.seatsTotal
  );
}

export function assertGroupJoinable(group: GroupShape, now: Date): void {
  if (isGroupJoinable(group, now)) return;
  throw new DomainError('GROUPBUY_GROUP_NOT_JOINABLE', {
    details: {
      status: group.status,
      seatsTaken: group.seatsTaken,
      seatsTotal: group.seatsTotal,
      expiresAt: group.expiresAt.toISOString(),
    },
  });
}

/**
 * A succeeded team with fewer real members than seats was completed by
 * 虚拟成团 — before 2026-09-23 the expiry sweep could do that when the shop
 * had switched it on, and an operator could with 立即成团. Neither can any
 * more, but teams completed that way keep reading as such. There is no flag
 * for it; the two counters are the evidence, and they cannot drift out of
 * agreement with themselves.
 */
export function wasVirtuallyFilled(
  group: { status: string; seatsTotal: number },
  realMembers: number,
): boolean {
  return group.status === 'succeeded' && realMembers < group.seatsTotal;
}

/**
 * 取消我发起的团.
 *
 * Only the leader, only while forming, and only while nobody has paid into it —
 * `seatsTaken === 0` means even the leader's own order is unpaid. A team with a
 * paid member is unwound by cancelling or refunding the *order*, never by this
 * route, because money is involved and this route moves none.
 */
export function assertWithdrawable(
  group: GroupShape & { leaderUserId: number },
  userId: number,
  now: Date,
): void {
  const ok =
    group.leaderUserId === userId &&
    group.status === 'forming' &&
    group.seatsTaken === 0 &&
    group.expiresAt.getTime() > now.getTime();
  if (ok) return;
  throw new DomainError('GROUPBUY_GROUP_NOT_WITHDRAWABLE', {
    details: {
      status: group.status,
      seatsTaken: group.seatsTaken,
      isLeader: group.leaderUserId === userId,
    },
  });
}

/** 立即成团: an operator may only complete a team that is forming and has somebody in it. */
export function assertCompletable(group: GroupShape): void {
  if (group.status === 'forming' && group.seatsTaken >= 1) return;
  throw new DomainError('GROUPBUY_GROUP_NOT_COMPLETABLE', {
    details: { status: group.status, seatsTaken: group.seatsTaken },
  });
}

// ---------------------------------------------------------------------------
// privacy — what a stranger sees of a team (RISK-D-010)
// ---------------------------------------------------------------------------

const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });

/**
 * `小明明` → `小*`: the nickname a team's members show to anybody who holds
 * the team link, the activity page and the poster.
 *
 * A team in this shop says who bought what, so a stranger gets one character
 * and a single star — never the length, never the rest. The first character is
 * a whole grapheme (an emoji with a skin tone or a ZWJ family stays one), not a
 * UTF-16 unit that would split a surrogate pair. A one-character name is all
 * star: keeping its only character would keep the whole name. Blank is `null`,
 * the same "no name" the client already draws for an account that never set
 * one.
 */
export function maskNickname(nickname: string | null): string | null {
  if (nickname === null) return null;
  const trimmed = nickname.trim();
  if (trimmed.length === 0) return null;
  const parts = Array.from(graphemes.segment(trimmed), (part) => part.segment);
  if (parts.length <= 1) return '*';
  return `${parts[0]}*`;
}

// ---------------------------------------------------------------------------
// price — the activity-price guard
// ---------------------------------------------------------------------------

export interface PricedLine {
  skuId: number;
  quantity: number;
}

/**
 * What the goods on a group-buy order *should* cost: the activity's per-SKU
 * price times the quantity, summed.
 *
 * `prices` is the activity's SKU table; a line whose SKU is not in it is not
 * part of the activity and is refused before any arithmetic happens.
 */
export function expectedGoodsTotal(
  lines: readonly PricedLine[],
  prices: ReadonlyMap<number, string>,
): Money {
  let total = Money.ZERO;
  for (const line of lines) {
    const price = prices.get(line.skuId);
    if (price === undefined) {
      throw new DomainError('GROUPBUY_SKU_NOT_IN_ACTIVITY', { details: { skuId: line.skuId } });
    }
    total = total.add(Money.parse(price).mul(line.quantity));
  }
  return total;
}

/**
 * The fail-closed half of the activity-price guard.
 *
 * `buildDraft` passes `kind` and every `kindMeta` key into the pricing
 * `selections`, so `groupbuyPricingContributor` fires and the order domain
 * books the gap between the catalogue price and the 拼团价 as an adjustment.
 * The shopper is charged the activity price — but by *another* domain's
 * arithmetic, through a registry this domain does not own.
 *
 * So the kind handler checks the result instead of trusting it, and checks it
 * where the result exists: after the order lines are written, against what they
 * actually charge. A contributor dropped from the registry, ordered behind
 * something that overwrites it, or silently returning `[]` again surfaces here
 * as a refused order rather than as a shopper paying 88.00 for a 59.00 team.
 *
 * Charging *less* is fine — a coupon on top is the shopper's own business — so
 * only charging more than the activity price is a bug.
 */
export function assertActivityPriceApplied(args: {
  expected: Money;
  charged: Money;
  activityId: number;
}): void {
  if (!args.charged.gt(args.expected)) return;
  throw new DomainError('GROUPBUY_PRICE_NOT_APPLIED', {
    details: {
      activityId: String(args.activityId),
      expected: args.expected.toString(),
      charged: args.charged.toString(),
    },
  });
}

/**
 * The same guard, one step earlier and from the other side.
 *
 * `PricingDraft.adjustments` carries what the pricing pass really took off, by
 * contributor, so `beforeCreate` can compare this domain's own adjustment with
 * the gap it was supposed to close — before an order row exists, before stock
 * moves, and without asking the contributor to run a second time inside the
 * creating transaction (which would cost a second pooled connection per
 * checkout).
 *
 * `afterCreate`'s check stays. The two are not redundant: this one proves the
 * *contributor* fired, that one proves the *written lines* charge what the
 * activity says. Both are a lookup and a comparison, so neither is worth
 * trading away for the other.
 *
 * Unlike the `charged` form above this is an equality. Both amounts are
 * negative — what the campaign owes the shopper off the catalogue price — and
 * an adjustment that differs either way means this domain's arithmetic and the
 * order domain's disagree about the same campaign.
 */
export function assertActivityDiscountApplied(args: {
  expected: Money;
  actual: Money;
  activityId: number;
}): void {
  if (args.expected.eq(args.actual)) return;
  throw new DomainError('GROUPBUY_PRICE_NOT_APPLIED', {
    details: {
      activityId: String(args.activityId),
      expected: args.expected.toString(),
      actual: args.actual.toString(),
    },
  });
}
