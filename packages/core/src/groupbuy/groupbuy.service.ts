import type { PageQuery } from '@shop/contracts/conventions';
import type {
  GroupbuyActivityDetail,
  GroupbuyActivityForm,
  GroupbuyActivityListItem,
  GroupbuyActivityListQuery,
  GroupbuyActivityOrder,
  GroupbuyActivityOrderQuery,
  GroupbuyActivityStat,
  GroupbuyActivityStatusBody,
  GroupbuyCard,
  GroupbuyDetail,
  GroupbuyGroupDetail,
  GroupbuyGroupListItem,
  GroupbuyGroupListQuery,
  GroupbuyGroupStatus,
  GroupbuyGroupView,
  GroupbuyListQuery,
  GroupbuyMember,
  GroupbuyOpenGroup,
  GroupbuyPoster,
  GroupbuyStatisticsQuery,
  GroupbuySummary,
  MyGroupbuyItem,
  MyGroupbuyListQuery,
} from '@shop/contracts/groupbuy/schemas';
import { GROUPBUY_SUMMARY_AVATAR_LIMIT } from '@shop/contracts/groupbuy/schemas';
import { toMiniPath } from '@shop/contracts/system/storefront-routes';
import { hasPermission } from '../auth/rbac';
import { DomainError } from '../kernel/errors';
import { resolveActivityStocks } from '../kernel/stock-edit';
import { toId, toIdOrNull } from '../kernel/ids';
import type { Ctx } from '../kernel/context';
import { recordEffect } from '../effects/index';
import { cancelOrder } from '../order';
import type { AccountCancelledListener } from '../user';
import { groupbuyConfig } from './groupbuy.config';
import { settleGroup } from './groupbuy.jobs';
import { groupbuyPermissions } from './permissions';
import * as repo from './groupbuy.repo';
import {
  assertCompletable,
  assertWithdrawable,
  isActivityOpen,
  isGroupJoinable,
  maskNickname,
  seatsLeft,
  wasVirtuallyFilled,
} from './groupbuy.rules';

/**
 * Group-buy services: everything a route file calls.
 *
 * The service decides, the repo states: every `if` about an affected row count
 * is here; every SQL statement is in `groupbuy.repo.ts`. What is *not* here is
 * joining a team: that is an order, and it lives in `groupbuy.order.ts` behind
 * the order domain's seams.
 *
 * The admin surface is audited for free: `handle()` writes an `audit_logs` row
 * for every mutating admin route, so 立即成团 carries the operator's account
 * without this file writing a line.
 */

type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };

// ---------------------------------------------------------------------------
// admin — activities
// ---------------------------------------------------------------------------

export async function adminActivityList(
  ctx: Ctx,
  query: GroupbuyActivityListQuery,
): Promise<Paged<GroupbuyActivityListItem>> {
  const { rows, total } = await repo.listActivities(ctx.db, {
    keyword: query.keyword,
    statuses: asArray(query.status),
    productId: query.productId === undefined ? undefined : Number(query.productId),
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    ...pageBounds(query),
  });
  const forming = await repo.countFormingGroupsByActivity(
    ctx.db,
    rows.map((row) => row.id),
  );
  return {
    items: rows.map((row) => toListItem(row, forming.get(row.id) ?? 0)),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function adminActivityDetail(
  ctx: Ctx,
  input: { id: string },
): Promise<GroupbuyActivityDetail> {
  const id = Number(input.id);
  const row = await mustFindActivity(ctx, id);
  return toDetail(ctx, row);
}

export async function adminActivityCreate(
  ctx: Ctx,
  body: GroupbuyActivityForm,
): Promise<GroupbuyActivityDetail> {
  return ctx.withTx(async (tx) => {
    await assertSkusBelongToProduct(tx, body);
    const now = ctx.clock.now();
    const row = await repo.insertActivity(tx, {
      ...activityValues(body),
      createdAt: now,
      updatedAt: now,
    });
    await repo.replaceActivitySkus(tx, { activityId: row.id, skus: skuValues(body) });
    const full = await mustFindActivity(ctx, row.id, tx);
    return toDetail(ctx, full, tx);
  });
}

/**
 * Edit.
 *
 * `seatsRequired` and `groupTtlSeconds` are copied onto every group when it
 * opens (`groupbuy_groups.seats_total`, `expires_at`), so raising the team size
 * mid-campaign cannot move the goalposts for a team already forming. That is
 * the whole reason those two columns are duplicated on the group row: without
 * it, a shopper's three-person team suddenly needs five.
 */
export async function adminActivityUpdate(
  ctx: Ctx,
  input: { id: string },
  body: GroupbuyActivityForm,
): Promise<GroupbuyActivityDetail> {
  const id = Number(input.id);
  return ctx.withTx(async (tx) => {
    const locked = await repo.lockActivityStock(tx, id);
    if (!locked) throw new DomainError('GROUPBUY_ACTIVITY_NOT_FOUND');
    // `ended` is terminal (see `adminActivitySetStatus`): the form cannot re-open it either.
    if (locked.status === 'ended' && body.status !== 'ended') {
      throw new DomainError('GROUPBUY_ACTIVITY_ENDED');
    }
    await assertSkusBelongToProduct(tx, body);
    const skus = skuValues(body);
    // RISK-D-012: a SKU orders still point at is switched off, never removed.
    const inUse = await repo.listRemovedSkusInUse(tx, {
      activityId: id,
      keep: skus.map((sku) => sku.skuId),
    });
    if (inUse.length > 0) {
      throw new DomainError('GROUPBUY_ACTIVITY_SKU_IN_USE', {
        details: { skuIds: inUse.map(String) },
      });
    }
    // Orders moved these counters while the form was open; see `resolveStockEdit`.
    const stocks = resolveActivityStocks(
      locked,
      { stock: body.stock, expectedStock: body.expectedStock, skus: expectedOf(body, skus) },
      'GROUPBUY_STOCK_CHANGED',
    );
    const now = ctx.clock.now();
    const moved = await repo.updateActivity(tx, id, {
      ...activityValues(body),
      stock: stocks.stock,
      updatedAt: now,
    });
    if (!moved.won) throw new DomainError('GROUPBUY_ACTIVITY_NOT_FOUND');
    await repo.replaceActivitySkus(tx, {
      activityId: id,
      skus: skus.map((sku) => ({ ...sku, stock: stocks.skuStocks.get(sku.skuId) ?? sku.stock })),
    });
    return toDetail(ctx, await mustFindActivity(ctx, id, tx), tx);
  });
}

export async function adminActivitySetStatus(
  ctx: Ctx,
  input: { id: string },
  body: GroupbuyActivityStatusBody,
): Promise<GroupbuyActivityDetail> {
  const id = Number(input.id);
  return ctx.withTx(async (tx) => {
    const moved = await repo.setActivityStatus(tx, {
      id,
      // `ended` is terminal: an expired campaign is not re-opened, it is copied.
      from: ['draft', 'active', 'paused'],
      to: body.status,
      now: ctx.clock.now(),
    });
    if (!moved.won) {
      const existing = await repo.findActivity(tx, id);
      if (!existing) throw new DomainError('GROUPBUY_ACTIVITY_NOT_FOUND');
      throw new DomainError('GROUPBUY_ACTIVITY_NOT_OPEN', {
        details: { status: existing.status },
      });
    }
    return toDetail(ctx, await mustFindActivity(ctx, id, tx), tx);
  });
}

/**
 * Soft delete, refused while a team is still forming.
 *
 * Deleting the activity outright would leave every live team pointing at
 * nothing, and the 拼团详情 page showing an empty card. The foreign key is
 * `ON DELETE RESTRICT` and this guard gives the operator a sentence instead of
 * a constraint error.
 */
export async function adminActivityDelete(ctx: Ctx, input: { id: string }): Promise<void> {
  const id = Number(input.id);
  await ctx.withTx(async (tx) => {
    await mustFindActivity(ctx, id, tx);
    const forming = await repo.countFormingGroups(tx, id);
    if (forming > 0) {
      throw new DomainError('GROUPBUY_ACTIVITY_IN_USE', { details: { formingGroups: forming } });
    }
    await repo.softDeleteActivity(tx, { id, now: ctx.clock.now() });
  });
}

export async function adminActivityOrders(
  ctx: Ctx,
  input: { id: string },
  query: GroupbuyActivityOrderQuery,
): Promise<Paged<GroupbuyActivityOrder>> {
  const activityId = Number(input.id);
  const { rows, total } = await repo.listActivityOrders(ctx.db, {
    activityId,
    groupStatus: query.groupStatus,
    paid: query.paid,
    ...pageBounds(query),
  });
  return {
    items: rows.map((row) => ({
      orderId: toId(row.orderId),
      orderNo: row.orderNo,
      groupId: toId(row.groupId),
      userId: toId(row.userId),
      nickname: row.nickname,
      role: row.role,
      memberStatus: row.memberStatus,
      groupStatus: row.groupStatus,
      quantity: row.quantity,
      payableAmount: row.payableAmount,
      paid: row.paid,
      createdAt: row.createdAt.toISOString(),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function adminStatistics(
  ctx: Ctx,
  query: GroupbuyStatisticsQuery,
): Promise<Paged<GroupbuyActivityStat>> {
  const { rows, total } = await repo.statistics(ctx.db, {
    activityId: query.activityId === undefined ? undefined : Number(query.activityId),
    from: query.from === undefined ? undefined : new Date(query.from),
    to: query.to === undefined ? undefined : new Date(query.to),
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    ...pageBounds(query),
  });
  return {
    items: rows.map((row) => ({
      activityId: toId(row.activityId),
      title: row.title,
      status: row.status,
      groups: row.groups,
      succeededGroups: row.succeededGroups,
      failedGroups: row.failedGroups,
      formingGroups: row.formingGroups,
      paidMembers: row.paidMembers,
      paidAmount: row.paidAmount,
      refundedMembers: row.refundedMembers,
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

// ---------------------------------------------------------------------------
// admin — groups
// ---------------------------------------------------------------------------

export async function adminGroupList(
  ctx: Ctx,
  query: GroupbuyGroupListQuery,
): Promise<Paged<GroupbuyGroupListItem>> {
  const { rows, total } = await repo.listGroups(ctx.db, {
    activityId: query.activityId === undefined ? undefined : Number(query.activityId),
    statuses: asArray(query.status),
    leaderUserId: query.leaderUserId === undefined ? undefined : Number(query.leaderUserId),
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    ...pageBounds(query),
  });
  return {
    items: rows.map(toGroupListItem),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function adminGroupDetail(
  ctx: Ctx,
  input: { id: string },
): Promise<GroupbuyGroupDetail> {
  const id = Number(input.id);
  const row = await repo.findGroupRow(ctx.db, id);
  if (!row) throw new DomainError('GROUPBUY_GROUP_NOT_FOUND');
  const members = await repo.listMembers(ctx.db, id);
  return { ...toGroupListItem(row), members: members.map(toMemberDto) };
}

/**
 * 立即成团.
 *
 * Gated on its own permission atom (`groupbuy:group:complete`), and it never
 * invents members: 虚拟成团 is off for good (2026-09-23; see
 * `groupbuy.config.ts`), so an under-filled team is refused with
 * `GROUPBUY_VIRTUAL_FILL_DISABLED` and settles at its deadline like any other.
 */
export async function adminGroupComplete(
  ctx: Ctx,
  input: { id: string },
  body: { reason?: string | undefined },
): Promise<GroupbuyGroupDetail> {
  const id = Number(input.id);

  await ctx.withTx(async (tx) => {
    const group = await repo.lockGroup(tx, id);
    if (!group) throw new DomainError('GROUPBUY_GROUP_NOT_FOUND');
    assertCompletable(group);
    if (group.seatsTaken < group.seatsTotal) {
      throw new DomainError('GROUPBUY_VIRTUAL_FILL_DISABLED', {
        details: { seatsTaken: group.seatsTaken, seatsTotal: group.seatsTotal },
      });
    }
    const filled = await repo.virtuallyFillAndSucceed(tx, { groupId: id, now: ctx.clock.now() });
    if (!filled.won) throw new DomainError('GROUPBUY_GROUP_NOT_COMPLETABLE');
    // The same effect the expiry path records for the same update, so 拼团成功
    // reaches a team an operator completed. `manual` lets the notification word
    // it differently; nothing reads it yet.
    await recordEffect(tx, ctx, {
      scope: 'groupbuy',
      scopeId: String(id),
      eventType: 'groupbuy.settle',
      payload: { groupId: String(id), outcome: 'succeeded', virtual: true, manual: true },
    });
    ctx.logger.info(
      { groupId: id, adminId: ctx.actor.id, reason: body.reason ?? null },
      'groupbuy: group completed manually',
    );
  });

  return adminGroupDetail(ctx, input);
}

// ---------------------------------------------------------------------------
// storefront
// ---------------------------------------------------------------------------

/**
 * `GET /api/v1/groupbuy/activities`: the 拼团 channel list, or with `ids` a DIY
 * 拼团 component's 指定数据 — those activities in the order saved, the
 * invisible skipped (`cardsFor`), then paged. `ids` and `productId` together
 * are the intersection: the picked activities that are that product's.
 */
export async function list(ctx: Ctx, query: GroupbuyListQuery): Promise<Paged<GroupbuyCard>> {
  if (query.ids !== undefined) {
    const cards = await cardsFor(ctx, query.ids, { productId: query.productId });
    const from = (query.page - 1) * query.pageSize;
    return {
      items: cards.slice(from, from + query.pageSize),
      total: cards.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
  const now = ctx.clock.now();
  const { rows, total } = await repo.listActivities(ctx.db, {
    visibleAt: now,
    productId: query.productId === undefined ? undefined : Number(query.productId),
    sortBy: 'sortOrder',
    sortOrder: 'desc',
    ...pageBounds(query),
  });
  const forming = await repo.countFormingGroupsByActivity(
    ctx.db,
    rows.map((row) => row.id),
  );
  return {
    items: rows.map((row) => toCard(row, forming.get(row.id) ?? 0, now)),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * The storefront cards of exactly these activities, in the order given — what
 * a DIY 拼团 block's manual pick shows. Read-only and additive: the same
 * visibility as `list` (active, inside its window, not deleted), so an id the
 * shopper could not see there is skipped here, as is a malformed or repeated
 * one. At most `DECOR_LIMITS.records` ids arrive, so one query answers it.
 */
export async function cardsFor(
  ctx: Ctx,
  ids: readonly string[],
  options: { productId?: string | undefined } = {},
): Promise<GroupbuyCard[]> {
  const wanted = [...new Set(ids.filter((id) => /^[1-9]\d{0,14}$/.test(id)))].map(Number);
  if (wanted.length === 0) return [];
  const now = ctx.clock.now();
  const { rows } = await repo.listActivities(ctx.db, {
    visibleAt: now,
    ids: wanted,
    productId: options.productId === undefined ? undefined : Number(options.productId),
    limit: wanted.length,
    offset: 0,
  });
  const forming = await repo.countFormingGroupsByActivity(
    ctx.db,
    rows.map((row) => row.id),
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return wanted.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toCard(row, forming.get(row.id) ?? 0, now)] : [];
  });
}

/** How long the 人气条 may be stale. A minute, and the strip says nothing that needs to be exact. */
const SUMMARY_CACHE_SECONDS = 60;
const SUMMARY_CACHE_KEY = 'groupbuy:summary';

/**
 * 人气条 — 「已有 N 人参与拼团」 plus a row of faces.
 *
 * Two aggregate scans over `groupbuy_members`, on the public landing tab of a
 * marketing surface, which is the shape of request that arrives in bursts: a
 * push notification goes out and every recipient opens the same page. So the
 * answer is cached in Redis for a minute, on one key — there is no window and
 * no user in it, so there is nothing to vary by.
 *
 * **A cache failure is never a page failure.** A Redis that is down, full or
 * unreachable means the aggregates run, the error is logged at `warn`, and the
 * shopper sees the right number. The same rule `stats.cache.ts` follows, for
 * the same reason: a decorative strip must not be able to 500 the 拼团 tab.
 *
 * Nothing invalidates the key on a join. A shopper who joins a team and sees
 * the count move a minute later is not a bug; a write path that has to know
 * about a cache key in another domain is.
 */
export async function summary(ctx: Ctx): Promise<GroupbuySummary> {
  try {
    const hit = await ctx.redis.get(SUMMARY_CACHE_KEY);
    if (hit !== null) return JSON.parse(hit) as GroupbuySummary;
  } catch (error) {
    ctx.logger.warn({ err: error, key: SUMMARY_CACHE_KEY }, 'groupbuy: summary cache read failed');
  }

  const now = ctx.clock.now();
  const [participants, avatars] = await Promise.all([
    repo.countLiveParticipants(ctx.db, now),
    repo.listLiveParticipantAvatars(ctx.db, { now, limit: GROUPBUY_SUMMARY_AVATAR_LIMIT }),
  ]);
  const value: GroupbuySummary = { participants, avatars };

  try {
    await ctx.redis.set(SUMMARY_CACHE_KEY, JSON.stringify(value), 'EX', SUMMARY_CACHE_SECONDS);
  } catch (error) {
    ctx.logger.warn({ err: error, key: SUMMARY_CACHE_KEY }, 'groupbuy: summary cache write failed');
  }
  return value;
}

/**
 * 注销 (`onAccountCancelled`): the shopper's places in teams stay, and the
 * team page, the activity's order list and the 人气条 show them without the
 * nickname and avatar frozen at join time (not even the masked 「小*」), the
 * way they show an account that never set either. The summary above may
 * still carry the face until its 60-second key expires.
 */
export const forgetMemberIdentity: AccountCancelledListener = async (tx, ctx, { userId }) => {
  await repo.clearMemberIdentityOf(tx, { userId, now: ctx.clock.now() });
};

export async function banners(
  ctx: Ctx,
): Promise<{ items: { imageUrl: string; link: string | null }[] }> {
  const config = await ctx.config.get(groupbuyConfig);
  return { items: config.banners.map((b) => ({ imageUrl: b.imageUrl, link: b.link })) };
}

export async function detail(ctx: Ctx, input: { id: string }): Promise<GroupbuyDetail> {
  const id = Number(input.id);
  const now = ctx.clock.now();
  const activity = await repo.findActivity(ctx.db, id);
  if (!activity) throw new DomainError('GROUPBUY_ACTIVITY_NOT_FOUND');

  const [skus, forming, description] = await Promise.all([
    repo.listActivitySkus(ctx.db, [id]),
    repo.countFormingGroupsByActivity(ctx.db, [id]),
    repo.findProductDescription(ctx.db, activity.productId),
  ]);

  // A shopper who is already in a live team is offered "看看我的团" instead of
  // "开团", so the page needs to know. `null` for an anonymous visitor: "cannot
  // join" and "we do not know you" are different answers.
  const userId = ctx.actor.kind === 'user' ? ctx.actor.id : null;
  const myOpenGroup =
    userId === null ? null : await repo.findMyOpenGroup(ctx.db, { activityId: id, userId, now });

  await repo.bumpViews(ctx.db, id);

  return {
    ...toCard(activity, forming.get(id) ?? 0, now),
    sliderImages: activity.sliderImages,
    groupTtlSeconds: activity.groupTtlSeconds,
    perOrderQuantity: activity.perOrderQuantity,
    description,
    skus: skus
      .filter((sku) => sku.isEnabled)
      .map((sku) => ({
        skuId: toId(sku.skuId),
        specText: sku.specText,
        specValues: sku.specValues,
        imageUrl: sku.imageUrl,
        price: sku.price,
        originalPrice: sku.skuOriginalPrice ?? sku.skuPrice,
        stock: sku.stock,
      })),
    myOpenGroupId: toIdOrNull(myOpenGroup?.id ?? null),
    myOpenGroupRole: myOpenGroup?.role ?? null,
  };
}

export async function openGroups(
  ctx: Ctx,
  input: { id: string },
  query: PageQuery,
): Promise<Paged<GroupbuyOpenGroup>> {
  const activityId = Number(input.id);
  const activity = await repo.findActivity(ctx.db, activityId);
  if (!activity) throw new DomainError('GROUPBUY_ACTIVITY_NOT_FOUND');
  const { rows, total } = await repo.listOpenGroups(ctx.db, {
    activityId,
    now: ctx.clock.now(),
    ...pageBounds(query),
  });
  return {
    items: rows.map((row) => ({
      groupId: toId(row.id),
      // Public route: a stranger's name stays masked (RISK-D-010).
      leaderNickname: maskNickname(row.leaderNickname),
      leaderAvatarUrl: row.leaderAvatarUrl,
      seatsTotal: row.seatsTotal,
      seatsTaken: row.seatsTaken,
      seatsLeft: seatsLeft(row),
      expiresAt: row.expiresAt.toISOString(),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function groupDetail(ctx: Ctx, input: { id: string }): Promise<GroupbuyGroupView> {
  return buildGroupView(ctx, Number(input.id));
}

/**
 * 取消我发起的团.
 *
 * Only a team nobody has paid into. Once money is in, the way out is the
 * *order* — `POST /api/v1/orders/:id/cancel` for an unpaid one, an after-sale
 * for a paid one — and the membership follows through `onOrderCancelled` /
 * `onOrderRefunded`. Deleting the membership rows directly would leave the
 * orders behind.
 *
 * The unpaid orders in the team — the leader's own 开团 order, and any joiner's
 * that was never paid — are closed with it (RISK-D-013): left open, the leader
 * could still pay for a team that no longer exists and be refunded
 * automatically. The team is cancelled first, so no new order can join it, and
 * the orders after, through the order domain's own cancel, which closes the
 * WeChat payment before it gives back stock and coupon. An order whose payment
 * lands in between stays paid and leaves through the refund a dead team's seat
 * already triggers.
 */
export async function withdraw(ctx: Ctx, input: { id: string }): Promise<GroupbuyGroupView> {
  const id = Number(input.id);
  const userId = requireShopper(ctx);
  const now = ctx.clock.now();

  await ctx.withTx(async (tx) => {
    const group = await repo.lockGroup(tx, id);
    if (!group) throw new DomainError('GROUPBUY_GROUP_NOT_FOUND');
    assertWithdrawable(group, userId, now);
    const cancelled = await repo.cancelEmptyGroup(tx, { groupId: id, now });
    if (!cancelled.won) throw new DomainError('GROUPBUY_GROUP_NOT_WITHDRAWABLE');
  });

  const unpaid = (await repo.listMembers(ctx.db, id)).filter(
    (member) => member.status === 'joined' && member.orderStatus === 'pending_payment',
  );
  for (const member of unpaid) {
    try {
      await cancelOrder(ctx, {
        orderId: member.orderId,
        reason: 'user',
        message: member.userId === userId ? '取消拼团，订单已关闭' : '团长已取消拼团，订单已关闭',
        ...(member.userId === userId ? { userId } : {}),
      });
    } catch (error) {
      // Paid, or the gateway could not say: the order stays as it is and the dead team's
      // seat refunds it if the money arrives. Nothing else here may fail the withdrawal.
      ctx.logger.warn(
        { err: error, orderId: member.orderId, groupId: id },
        'groupbuy: order of a withdrawn team left open',
      );
    }
  }

  return buildGroupView(ctx, id);
}

export async function myGroups(
  ctx: Ctx,
  query: MyGroupbuyListQuery,
): Promise<Paged<MyGroupbuyItem>> {
  const userId = requireShopper(ctx);
  const { rows, total } = await repo.listMyGroups(ctx.db, {
    userId,
    status: query.status,
    ...pageBounds(query),
  });
  return {
    items: rows.map((row) => ({
      groupId: toId(row.groupId),
      activityId: toId(row.activityId),
      title: row.activityTitle,
      imageUrl: row.activityImageUrl,
      status: row.groupStatus,
      role: row.role,
      memberStatus: row.status,
      orderId: toId(row.orderId),
      seatsTotal: row.seatsTotal,
      seatsTaken: row.seatsTaken,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * Poster **data**, not a poster.
 *
 * The client composes the image; the server answers with the fields and the
 * string the QR code should encode. A PNG rendered server-side would be an
 * attachment per group — a cache nothing sweeps.
 */
export async function poster(ctx: Ctx, input: { id: string }): Promise<GroupbuyPoster> {
  const id = Number(input.id);
  requireShopper(ctx);
  const row = await repo.findGroupRow(ctx.db, id);
  if (!row) throw new DomainError('GROUPBUY_GROUP_NOT_FOUND');
  const route = { route: 'groupbuyTeam', params: { id: toId(id) } } as const;
  const page = toMiniPath(route);
  return {
    groupId: toId(id),
    title: row.activityTitle,
    imageUrl: row.activityImageUrl,
    price: row.activityPrice,
    originalPrice: row.activityOriginalPrice,
    seatsLeft: seatsLeft(row),
    expiresAt: row.expiresAt.toISOString(),
    // Masked for everybody, the leader included: a poster is made to be passed
    // on, and any signed-in shopper may ask for any team's (RISK-D-010).
    leaderNickname: maskNickname(row.leaderNickname),
    leaderAvatarUrl: row.leaderAvatarUrl,
    qrPayload: page,
    page,
    route,
  };
}

/** Re-exported so the worker's job modules do not reach past `index.ts`. */
export { settleGroup };

// ---------------------------------------------------------------------------
// mapping
// ---------------------------------------------------------------------------

async function buildGroupView(ctx: Ctx, groupId: number): Promise<GroupbuyGroupView> {
  const row = await repo.findGroupRow(ctx.db, groupId);
  if (!row) throw new DomainError('GROUPBUY_GROUP_NOT_FOUND');
  const now = ctx.clock.now();
  const paid = await repo.listPaidMembers(ctx.db, groupId);
  const userId = ctx.actor.kind === 'user' ? ctx.actor.id : null;
  const mine = userId === null ? null : await repo.findMember(ctx.db, { groupId, userId });

  return {
    groupId: toId(groupId),
    activityId: toId(row.activityId),
    title: row.activityTitle,
    imageUrl: row.activityImageUrl,
    price: row.activityPrice,
    status: row.status,
    seatsTotal: row.seatsTotal,
    seatsTaken: row.seatsTaken,
    seatsLeft: seatsLeft(row),
    expiresAt: row.expiresAt.toISOString(),
    succeededAt: row.succeededAt?.toISOString() ?? null,
    // Paid and unrefunded only: an unpaid order is not a participant, and
    // showing one would be a "phantom member" in the participant list. Anybody
    // with the link reads this, so no account id and a masked name; "is this
    // seat mine" comes from the session, never from an id the client compares
    // (RISK-D-010).
    members: paid.map((member) => ({
      nickname: maskNickname(member.nickname),
      avatarUrl: member.avatarUrl,
      role: member.role,
      isMe: userId !== null && member.userId === userId,
    })),
    me:
      mine === null
        ? null
        : {
            role: mine.role,
            status: mine.status,
            orderId: toId(mine.orderId),
            paid: paid.some((member) => member.id === mine.id),
          },
    canJoin: mine === null && isGroupJoinable(row, now),
  };
}

async function mustFindActivity(
  ctx: Ctx,
  id: number,
  tx?: Parameters<typeof repo.findActivity>[0],
): Promise<repo.ActivityRow> {
  const row = await repo.findActivity(tx ?? ctx.db, id);
  if (!row) throw new DomainError('GROUPBUY_ACTIVITY_NOT_FOUND');
  return row;
}

/**
 * A SKU the form names must really belong to the product. Without this an
 * operator (or a hand-crafted body) could attach a 1 元 group price to somebody
 * else's SKU and the `product_skus` join would happily serve it.
 */
async function assertSkusBelongToProduct(
  tx: Parameters<typeof repo.skuIdsOfProduct>[0],
  body: GroupbuyActivityForm,
): Promise<void> {
  if (body.skus.length === 0) return;
  const owned = new Set(await repo.skuIdsOfProduct(tx, Number(body.productId)));
  for (const sku of body.skus) {
    if (!owned.has(Number(sku.skuId))) {
      throw new DomainError('GROUPBUY_SKU_NOT_IN_ACTIVITY', { details: { skuId: sku.skuId } });
    }
  }
}

function activityValues(body: GroupbuyActivityForm) {
  return {
    productId: Number(body.productId),
    title: body.title,
    intro: body.intro ?? null,
    imageUrl: body.imageUrl ?? null,
    sliderImages: body.sliderImages,
    status: body.status,
    price: body.price,
    originalPrice: body.originalPrice ?? null,
    cost: body.cost ?? null,
    seatsRequired: body.seatsRequired,
    groupTtlSeconds: body.groupTtlSeconds,
    stock: body.stock,
    totalQuota: body.totalQuota ?? null,
    perOrderQuantity: body.perOrderQuantity,
    startAt: new Date(body.startAt),
    endAt: new Date(body.endAt),
    shippingTemplateId:
      body.shippingTemplateId === undefined ? null : Number(body.shippingTemplateId),
    sortOrder: body.sortOrder,
  };
}

function skuValues(body: GroupbuyActivityForm): repo.ActivitySkuInput[] {
  return body.skus.map((sku) => ({
    skuId: Number(sku.skuId),
    price: sku.price,
    stock: sku.stock,
    quota: sku.quota ?? null,
    isEnabled: sku.isEnabled,
  }));
}

/** The form's SKUs with the stock each was showing when it loaded. */
function expectedOf(body: GroupbuyActivityForm, skus: readonly repo.ActivitySkuInput[]) {
  return skus.map((sku, index) => ({ ...sku, expectedStock: body.skus[index]?.expectedStock }));
}

function toListItem(row: repo.ActivityRow, formingGroups: number): GroupbuyActivityListItem {
  return {
    id: toId(row.id),
    productId: toId(row.productId),
    productName: row.productName,
    title: row.title,
    intro: row.intro,
    imageUrl: row.imageUrl,
    status: row.status,
    price: row.price,
    originalPrice: row.originalPrice,
    seatsRequired: row.seatsRequired,
    groupTtlSeconds: row.groupTtlSeconds,
    stock: row.stock,
    sales: row.sales,
    totalQuota: row.totalQuota,
    perOrderQuantity: row.perOrderQuantity,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    sortOrder: row.sortOrder,
    formingGroups,
    createdAt: row.createdAt.toISOString(),
  };
}

async function toDetail(
  ctx: Ctx,
  row: repo.ActivityRow,
  tx?: Parameters<typeof repo.listActivitySkus>[0],
): Promise<GroupbuyActivityDetail> {
  const db = tx ?? ctx.db;
  const [skus, forming] = await Promise.all([
    repo.listActivitySkus(db, [row.id]),
    repo.countFormingGroupsByActivity(db, [row.id]),
  ]);
  return {
    ...toListItem(row, forming.get(row.id) ?? 0),
    sliderImages: row.sliderImages,
    // 成本价 is margin: the editor that sets it sees it, a look-only role gets
    // `null` (catalog's rule). It cannot save, so the `null` never comes back.
    cost: hasPermission(ctx.actor, groupbuyPermissions['activity:write']) ? row.cost : null,
    shippingTemplateId: toIdOrNull(row.shippingTemplateId),
    views: row.views,
    skus: skus.map((sku) => ({
      skuId: toId(sku.skuId),
      specText: sku.specText,
      price: sku.price,
      stock: sku.stock,
      sales: sku.sales,
      quota: sku.quota,
      isEnabled: sku.isEnabled,
    })),
  };
}

function toCard(row: repo.ActivityRow, formingGroups: number, now: Date): GroupbuyCard {
  return {
    activityId: toId(row.id),
    productId: toId(row.productId),
    title: row.title,
    intro: row.intro,
    imageUrl: row.imageUrl,
    price: row.price,
    originalPrice: row.originalPrice,
    seatsRequired: row.seatsRequired,
    stock: row.stock,
    sales: row.sales,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    formingGroups,
    // The server's decision, never the client's: the button is disabled by the
    // same rule the `OrderKindHandler` will enforce a moment later.
    canBuy: isActivityOpen(row, now) && row.stock > 0,
  };
}

function toGroupListItem(row: repo.GroupRow): GroupbuyGroupListItem {
  return {
    id: toId(row.id),
    activityId: toId(row.activityId),
    activityTitle: row.activityTitle,
    leaderUserId: toId(row.leaderUserId),
    leaderNickname: row.leaderNickname,
    seatsTotal: row.seatsTotal,
    seatsTaken: row.seatsTaken,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    succeededAt: row.succeededAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
    virtuallyFilled: wasVirtuallyFilled(row, row.realMembers),
    createdAt: row.createdAt.toISOString(),
  };
}

function toMemberDto(row: repo.MemberRow): GroupbuyMember {
  return {
    id: toId(row.id),
    userId: toId(row.userId),
    orderId: toId(row.orderId),
    orderNo: row.orderNo,
    role: row.role,
    status: row.status,
    nickname: row.nickname,
    avatarUrl: row.avatarUrl,
    quantity: row.quantity,
    paid: row.paid,
    joinedAt: row.createdAt.toISOString(),
    leftAt: row.leftAt?.toISOString() ?? null,
  };
}

function requireShopper(ctx: Ctx): number {
  if (ctx.actor.kind !== 'user' || ctx.actor.id === null) {
    throw new DomainError('UNAUTHENTICATED');
  }
  return ctx.actor.id;
}

function pageBounds(query: PageQuery): { offset: number; limit: number } {
  return { offset: (query.page - 1) * query.pageSize, limit: query.pageSize };
}

/** `status=a&status=b` reaches the service as an array; one value as a scalar. */
function asArray<T extends string>(value: T | readonly T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? [...value] : [value as T];
}

export type { GroupbuyGroupStatus };
