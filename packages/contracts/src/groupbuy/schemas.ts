import { z } from 'zod';
import { id, idList, instant, money, pageQuery, paged, sortQuery } from '../_conventions/common';
import { storefrontRoute } from '../system/storefront-routes';

/**
 * Shapes shared by the group-buy routes.
 *
 * The enums are the PostgreSQL enums of `db/src/schema/groupbuy.ts`, spelled
 * the same way and *not* imported from `@shop/db` — contracts are the bottom
 * layer. `groupbuy.service.ts` assigns one to the other and stops compiling if
 * they ever drift.
 *
 * Two things worth knowing before the shapes:
 *
 * - a **group** is a real row with a real seat counter, so the storefront is
 *   told `seatsTotal` / `seatsTaken` rather than being handed a list of
 *   participants to count;
 * - a **poster** is data plus a QR payload. The server never draws one; the
 *   client composes it.
 */

// ---------------------------------------------------------------------------
// enums
// ---------------------------------------------------------------------------

export const groupbuyActivityStatus = z.enum(['draft', 'active', 'paused', 'ended']);
export type GroupbuyActivityStatus = z.infer<typeof groupbuyActivityStatus>;

export const groupbuyGroupStatus = z.enum(['forming', 'succeeded', 'failed', 'cancelled']);
export type GroupbuyGroupStatus = z.infer<typeof groupbuyGroupStatus>;

export const groupbuyMemberRole = z.enum(['leader', 'member']);
export type GroupbuyMemberRole = z.infer<typeof groupbuyMemberRole>;

export const groupbuyMemberStatus = z.enum(['joined', 'refunded', 'cancelled']);
export type GroupbuyMemberStatus = z.infer<typeof groupbuyMemberStatus>;

// ---------------------------------------------------------------------------
// admin: activities
// ---------------------------------------------------------------------------

/** One SKU of an activity: its group price and its own stock ledger. */
export const groupbuyActivitySku = z.object({
  skuId: id,
  /** Frozen at read time from `product_skus`, so the operator can tell the rows apart. */
  specText: z.string(),
  price: money,
  stock: z.number().int().min(0),
  sales: z.number().int().min(0),
  quota: z.number().int().min(0).nullable(),
  isEnabled: z.boolean(),
});
export type GroupbuyActivitySku = z.infer<typeof groupbuyActivitySku>;

/** The editable half of an activity SKU. `sales` is the server's to move. */
export const groupbuyActivitySkuInput = z.object({
  skuId: id,
  price: money,
  stock: z.number().int().min(0).max(1_000_000),
  /** The stock the form loaded with; see `expectedStock` on the product SKU input. */
  expectedStock: z.number().int().min(0).optional(),
  quota: z.number().int().min(0).max(1_000_000).optional(),
  isEnabled: z.boolean().default(true),
});
export type GroupbuyActivitySkuInput = z.infer<typeof groupbuyActivitySkuInput>;

export const groupbuyActivityListItem = z.object({
  id,
  productId: id,
  productName: z.string(),
  title: z.string(),
  intro: z.string().nullable(),
  imageUrl: z.string().nullable(),
  status: groupbuyActivityStatus,
  price: money,
  originalPrice: money.nullable(),
  seatsRequired: z.number().int().min(2),
  groupTtlSeconds: z.number().int().min(1),
  stock: z.number().int().min(0),
  sales: z.number().int().min(0),
  totalQuota: z.number().int().min(0).nullable(),
  perOrderQuantity: z.number().int().min(1),
  startAt: instant,
  endAt: instant,
  sortOrder: z.number().int(),
  /** Groups in `forming`, for the "还有 N 个团在拼" column. */
  formingGroups: z.number().int().min(0),
  createdAt: instant,
});
export type GroupbuyActivityListItem = z.infer<typeof groupbuyActivityListItem>;

export const groupbuyActivityDetail = groupbuyActivityListItem.extend({
  sliderImages: z.array(z.string()),
  cost: money.nullable(),
  shippingTemplateId: id.nullable(),
  views: z.number().int().min(0),
  skus: z.array(groupbuyActivitySku),
});
export type GroupbuyActivityDetail = z.infer<typeof groupbuyActivityDetail>;

/**
 * Create / update body.
 *
 * The refinements mirror `groupbuy_activities_window_ordered`,
 * `groupbuy_activities_seats_required` and `groupbuy_activities_ttl_positive`:
 * a form that cannot reach the database is a 422 with a field error, not a 500
 * from a CHECK violation. `ZodForm` runs the same schema in the browser.
 *
 * There is **no per-activity 虚拟成团 switch**: the schema has no column for
 * it, so it is a shop-wide setting in the `groupbuy` config group.
 */
export const groupbuyActivityForm = z
  .object({
    productId: id,
    title: z.string().min(1).max(255),
    intro: z.string().max(255).optional(),
    imageUrl: z.string().max(512).optional(),
    sliderImages: z.array(z.string().max(512)).max(10).default([]),
    status: groupbuyActivityStatus.default('draft'),
    /** Fallback group price, used when the product has a single SKU. */
    price: money,
    originalPrice: money.optional(),
    cost: money.optional(),
    seatsRequired: z.number().int().min(2).max(100),
    /** 拼团有效时长, in seconds — stored and edited as such. */
    groupTtlSeconds: z
      .number()
      .int()
      .min(60)
      .max(30 * 24 * 3600),
    stock: z.number().int().min(0).max(1_000_000),
    /**
     * The stock the form loaded with. Unchanged, the live number is kept;
     * changed while orders moved it, the save is refused with `*_STOCK_CHANGED`.
     */
    expectedStock: z.number().int().min(0).optional(),
    totalQuota: z.number().int().min(0).max(1_000_000).optional(),
    /** 每单限购份数. */
    perOrderQuantity: z.number().int().min(1).max(999).default(1),
    startAt: instant,
    endAt: instant,
    shippingTemplateId: id.optional(),
    sortOrder: z.number().int().min(0).max(9999).default(0),
    skus: z.array(groupbuyActivitySkuInput).max(200).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.endAt <= value.startAt) {
      ctx.addIssue({ code: 'custom', path: ['endAt'], message: '结束时间必须晚于开始时间' });
    }
    const seen = new Set<string>();
    for (const [index, sku] of value.skus.entries()) {
      if (seen.has(sku.skuId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['skus', index, 'skuId'],
          message: '同一规格只能配置一次',
        });
      }
      seen.add(sku.skuId);
    }
  });
export type GroupbuyActivityForm = z.infer<typeof groupbuyActivityForm>;

export const groupbuyActivityListQuery = pageQuery
  .extend({
    keyword: z.string().trim().max(64).optional(),
    status: z.union([groupbuyActivityStatus, z.array(groupbuyActivityStatus)]).optional(),
    productId: id.optional(),
  })
  .extend(sortQuery(['id', 'sortOrder', 'sales', 'startAt', 'createdAt']).shape);
export type GroupbuyActivityListQuery = z.infer<typeof groupbuyActivityListQuery>;

export const pagedGroupbuyActivities = paged(groupbuyActivityListItem);

export const groupbuyActivityStatusBody = z.object({
  status: z.enum(['active', 'paused']),
});
export type GroupbuyActivityStatusBody = z.infer<typeof groupbuyActivityStatusBody>;

// ---------------------------------------------------------------------------
// admin: groups and statistics
// ---------------------------------------------------------------------------

export const groupbuyMember = z.object({
  id,
  userId: id,
  orderId: id,
  orderNo: z.string(),
  role: groupbuyMemberRole,
  status: groupbuyMemberStatus,
  /** Frozen at join time, so the card does not change under the buyer. */
  nickname: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  quantity: z.number().int().min(1),
  /** `true` once the member's order is paid — that is when the seat is taken. */
  paid: z.boolean(),
  joinedAt: instant,
  leftAt: instant.nullable(),
});
export type GroupbuyMember = z.infer<typeof groupbuyMember>;

export const groupbuyGroupListItem = z.object({
  id,
  activityId: id,
  activityTitle: z.string(),
  leaderUserId: id,
  leaderNickname: z.string().nullable(),
  seatsTotal: z.number().int().min(2),
  seatsTaken: z.number().int().min(0),
  status: groupbuyGroupStatus,
  expiresAt: instant,
  succeededAt: instant.nullable(),
  failedAt: instant.nullable(),
  /** `true` when the group reached `succeeded` with fewer real buyers than seats. */
  virtuallyFilled: z.boolean(),
  createdAt: instant,
});
export type GroupbuyGroupListItem = z.infer<typeof groupbuyGroupListItem>;

export const groupbuyGroupDetail = groupbuyGroupListItem.extend({
  members: z.array(groupbuyMember),
});
export type GroupbuyGroupDetail = z.infer<typeof groupbuyGroupDetail>;

export const groupbuyGroupListQuery = pageQuery
  .extend({
    activityId: id.optional(),
    status: z.union([groupbuyGroupStatus, z.array(groupbuyGroupStatus)]).optional(),
    leaderUserId: id.optional(),
  })
  .extend(sortQuery(['id', 'createdAt', 'expiresAt']).shape);
export type GroupbuyGroupListQuery = z.infer<typeof groupbuyGroupListQuery>;

export const pagedGroupbuyGroups = paged(groupbuyGroupListItem);

/**
 * 立即成团. The operator's name is the audit trail, and the audit row is
 * written by `handle()`, so this body only carries the reason.
 */
export const groupbuyCompleteBody = z.object({
  reason: z.string().max(255).optional(),
});
export type GroupbuyCompleteBody = z.infer<typeof groupbuyCompleteBody>;

/** One row of 拼团统计: an activity and how it performed. */
export const groupbuyActivityStat = z.object({
  activityId: id,
  title: z.string(),
  status: groupbuyActivityStatus,
  /** Groups opened, of any outcome. */
  groups: z.number().int().min(0),
  succeededGroups: z.number().int().min(0),
  failedGroups: z.number().int().min(0),
  formingGroups: z.number().int().min(0),
  /** Members whose order is paid and not refunded. */
  paidMembers: z.number().int().min(0),
  /** Sum of `orders.payable_amount` over those members' orders. */
  paidAmount: money,
  refundedMembers: z.number().int().min(0),
});
export type GroupbuyActivityStat = z.infer<typeof groupbuyActivityStat>;

export const groupbuyStatisticsQuery = pageQuery
  .extend({
    from: instant.optional(),
    to: instant.optional(),
    activityId: id.optional(),
  })
  .extend(sortQuery(['groups', 'paidMembers', 'paidAmount']).shape);
export type GroupbuyStatisticsQuery = z.infer<typeof groupbuyStatisticsQuery>;

export const pagedGroupbuyStatistics = paged(groupbuyActivityStat);

/** One order placed through a group buy, for 拼团订单 under an activity. */
export const groupbuyActivityOrder = z.object({
  orderId: id,
  orderNo: z.string(),
  groupId: id,
  userId: id,
  nickname: z.string().nullable(),
  role: groupbuyMemberRole,
  memberStatus: groupbuyMemberStatus,
  groupStatus: groupbuyGroupStatus,
  quantity: z.number().int().min(1),
  payableAmount: money,
  paid: z.boolean(),
  createdAt: instant,
});
export type GroupbuyActivityOrder = z.infer<typeof groupbuyActivityOrder>;

export const groupbuyActivityOrderQuery = pageQuery.extend({
  groupStatus: groupbuyGroupStatus.optional(),
  paid: z.stringbool().optional(),
});
export type GroupbuyActivityOrderQuery = z.infer<typeof groupbuyActivityOrderQuery>;

export const pagedGroupbuyActivityOrders = paged(groupbuyActivityOrder);

// ---------------------------------------------------------------------------
// storefront
// ---------------------------------------------------------------------------

/** An activity on the 拼团列表. `canBuy` is the server's decision, never the client's. */
export const groupbuyCard = z.object({
  activityId: id,
  productId: id,
  title: z.string(),
  intro: z.string().nullable(),
  imageUrl: z.string().nullable(),
  price: money,
  originalPrice: money.nullable(),
  seatsRequired: z.number().int().min(2),
  stock: z.number().int().min(0),
  sales: z.number().int().min(0),
  startAt: instant,
  endAt: instant,
  /** Groups still looking for members right now. */
  formingGroups: z.number().int().min(0),
  canBuy: z.boolean(),
});
export type GroupbuyCard = z.infer<typeof groupbuyCard>;

export const groupbuyListQuery = pageQuery.extend({
  /**
   * Only this product's activities — what 商品详情 asks to learn whether a product is on
   * 拼团 right now. The list's own rule still holds: `active` and inside its window.
   */
  productId: id.optional(),
  /**
   * Exactly these activities, in this order — what a DIY 拼团 component's
   * 指定数据 saved. An activity the shopper cannot see now (paused, outside its
   * window, deleted) is skipped, not an error. With `productId` as well, the
   * intersection: the picked activities that are that product's, still in the
   * picked order.
   */
  ids: idList.optional(),
});
export type GroupbuyListQuery = z.infer<typeof groupbuyListQuery>;
export const pagedGroupbuyCards = paged(groupbuyCard);

/** The SKU picker on the activity page. */
export const groupbuyStorefrontSku = z.object({
  skuId: id,
  specText: z.string(),
  specValues: z.record(z.string(), z.string()),
  imageUrl: z.string().nullable(),
  price: money,
  originalPrice: money.nullable(),
  stock: z.number().int().min(0),
});
export type GroupbuyStorefrontSku = z.infer<typeof groupbuyStorefrontSku>;

export const groupbuyDetail = groupbuyCard.extend({
  sliderImages: z.array(z.string()),
  groupTtlSeconds: z.number().int().min(1),
  perOrderQuantity: z.number().int().min(1),
  description: z.string().nullable(),
  skus: z.array(groupbuyStorefrontSku),
  /** `null` for an anonymous visitor: "cannot join" and "we do not know you" differ. */
  myOpenGroupId: id.nullable(),
  /**
   * The caller's seat in `myOpenGroupId`: `leader` for a team they opened (你发起的团), `member`
   * for one they joined. `null` exactly when `myOpenGroupId` is.
   */
  myOpenGroupRole: groupbuyMemberRole.nullable(),
});
export type GroupbuyDetail = z.infer<typeof groupbuyDetail>;

/** A group a shopper may join, on the activity page or the 拼单 list. */
export const groupbuyOpenGroup = z.object({
  groupId: id,
  /** Masked, `小*` — this route is public (RISK-D-010). */
  leaderNickname: z.string().nullable(),
  leaderAvatarUrl: z.string().nullable(),
  seatsTotal: z.number().int().min(2),
  seatsTaken: z.number().int().min(0),
  seatsLeft: z.number().int().min(0),
  expiresAt: instant,
});
export type GroupbuyOpenGroup = z.infer<typeof groupbuyOpenGroup>;

export const pagedGroupbuyOpenGroups = paged(groupbuyOpenGroup);

/** 拼团状态页. Everything the buyer's group card needs, in one read. */
export const groupbuyGroupView = z.object({
  groupId: id,
  activityId: id,
  title: z.string(),
  imageUrl: z.string().nullable(),
  price: money,
  status: groupbuyGroupStatus,
  seatsTotal: z.number().int().min(2),
  seatsTaken: z.number().int().min(0),
  seatsLeft: z.number().int().min(0),
  expiresAt: instant,
  succeededAt: instant.nullable(),
  /**
   * Paid, unrefunded members only — an unpaid order is not a participant.
   *
   * Anybody holding the team link reads this, signed in or not, so a member
   * carries no account id and a masked nickname (`小*`, RISK-D-010). Whether a
   * seat is the caller's own is `isMe`, decided from the session on the server.
   */
  members: z.array(
    z.object({
      nickname: z.string().nullable(),
      avatarUrl: z.string().nullable(),
      role: groupbuyMemberRole,
      isMe: z.boolean(),
    }),
  ),
  /** The caller's own place in this group, or `null` (including anonymous). */
  me: z
    .object({
      role: groupbuyMemberRole,
      status: groupbuyMemberStatus,
      orderId: id,
      paid: z.boolean(),
    })
    .nullable(),
  /** Whether the caller may still join. `false` for a member, a full team, a dead team. */
  canJoin: z.boolean(),
});
export type GroupbuyGroupView = z.infer<typeof groupbuyGroupView>;

export const myGroupbuyListQuery = pageQuery.extend({
  status: groupbuyGroupStatus.optional(),
});
export type MyGroupbuyListQuery = z.infer<typeof myGroupbuyListQuery>;

export const myGroupbuyItem = z.object({
  groupId: id,
  activityId: id,
  title: z.string(),
  imageUrl: z.string().nullable(),
  status: groupbuyGroupStatus,
  role: groupbuyMemberRole,
  memberStatus: groupbuyMemberStatus,
  orderId: id,
  seatsTotal: z.number().int().min(2),
  seatsTaken: z.number().int().min(0),
  expiresAt: instant,
  createdAt: instant,
});
export type MyGroupbuyItem = z.infer<typeof myGroupbuyItem>;

export const pagedMyGroupbuy = paged(myGroupbuyItem);

/**
 * Poster data. The server returns the pieces and the payload a QR code must
 * encode; the client draws the image. A server-rendered PNG would be one more
 * stored file per group that nothing ever cleans up.
 */
export const groupbuyPoster = z.object({
  groupId: id,
  title: z.string(),
  imageUrl: z.string().nullable(),
  price: money,
  originalPrice: money.nullable(),
  seatsLeft: z.number().int().min(0),
  expiresAt: instant,
  /** Masked, `小*`: the poster is drawn to be passed around (RISK-D-010). */
  leaderNickname: z.string().nullable(),
  leaderAvatarUrl: z.string().nullable(),
  /**
   * What the QR code encodes — the team page's mini-program path, never an
   * image. The mini program draws its 小程序码 from `GET /share/mini-codes`
   * with `route` instead.
   */
  qrPayload: z.string(),
  /** The team page's mini-program path (`toMiniPath(route)`), no leading `/`. */
  page: z.string(),
  /** The team page in the storefront route catalogue: `groupbuyTeam { id }`. */
  route: storefrontRoute,
});
export type GroupbuyPoster = z.infer<typeof groupbuyPoster>;

// ---------------------------------------------------------------------------
// examples
// ---------------------------------------------------------------------------

/**
 * One coherent fixture reused by every example, so the mock server tells the
 * mini program and the admin a single story: activity 1 (三只松鼠坚果礼盒, three
 * seats, 拼团价 59.00 against 88.00), group 501 with two of three seats taken
 * by 小明 (leader) and 小红.
 */
export const groupbuyActivityExample: GroupbuyActivityListItem = {
  id: '1',
  productId: '11',
  productName: '有机三只松鼠坚果礼盒',
  title: '三人成团 · 坚果礼盒',
  intro: '三人成团立减 29 元',
  imageUrl: 'https://cdn.example.com/p/11.jpg',
  status: 'active',
  price: '59.00',
  originalPrice: '88.00',
  seatsRequired: 3,
  groupTtlSeconds: 86400,
  stock: 200,
  sales: 46,
  totalQuota: 500,
  perOrderQuantity: 1,
  startAt: '2026-09-01T00:00:00+08:00',
  endAt: '2026-10-31T23:59:59+08:00',
  sortOrder: 0,
  formingGroups: 4,
  createdAt: '2026-08-20T10:00:00+08:00',
};

export const groupbuyActivitySkuExample: GroupbuyActivitySku = {
  skuId: '21',
  specText: '混合装|1000g',
  price: '59.00',
  stock: 200,
  sales: 46,
  quota: 500,
  isEnabled: true,
};

export const groupbuyActivityDetailExample: GroupbuyActivityDetail = {
  ...groupbuyActivityExample,
  sliderImages: ['https://cdn.example.com/p/11-1.jpg'],
  cost: '31.00',
  shippingTemplateId: null,
  views: 1284,
  skus: [groupbuyActivitySkuExample],
};

export const groupbuyGroupExample: GroupbuyGroupListItem = {
  id: '501',
  activityId: '1',
  activityTitle: '三人成团 · 坚果礼盒',
  leaderUserId: '101',
  leaderNickname: '小明',
  seatsTotal: 3,
  seatsTaken: 2,
  status: 'forming',
  expiresAt: '2026-09-23T10:00:00+08:00',
  succeededAt: null,
  failedAt: null,
  virtuallyFilled: false,
  createdAt: '2026-09-22T10:00:00+08:00',
};

export const groupbuyMemberExample: GroupbuyMember = {
  id: '9001',
  userId: '101',
  orderId: '7001',
  orderNo: '202609221000000000000001',
  role: 'leader',
  status: 'joined',
  nickname: '小明',
  avatarUrl: 'https://cdn.example.com/u/101.jpg',
  quantity: 1,
  paid: true,
  joinedAt: '2026-09-22T10:00:00+08:00',
  leftAt: null,
};

export const groupbuyGroupDetailExample: GroupbuyGroupDetail = {
  ...groupbuyGroupExample,
  members: [
    groupbuyMemberExample,
    {
      ...groupbuyMemberExample,
      id: '9002',
      userId: '102',
      orderId: '7002',
      orderNo: '202609221000000000000002',
      role: 'member',
      nickname: '小红',
      avatarUrl: 'https://cdn.example.com/u/102.jpg',
      joinedAt: '2026-09-22T10:20:00+08:00',
    },
  ],
};

export const groupbuyCardExample: GroupbuyCard = {
  activityId: '1',
  productId: '11',
  title: '三人成团 · 坚果礼盒',
  intro: '三人成团立减 29 元',
  imageUrl: 'https://cdn.example.com/p/11.jpg',
  price: '59.00',
  originalPrice: '88.00',
  seatsRequired: 3,
  stock: 200,
  sales: 46,
  startAt: '2026-09-01T00:00:00+08:00',
  endAt: '2026-10-31T23:59:59+08:00',
  formingGroups: 4,
  canBuy: true,
};

export const groupbuyDetailExample: GroupbuyDetail = {
  ...groupbuyCardExample,
  sliderImages: ['https://cdn.example.com/p/11-1.jpg'],
  groupTtlSeconds: 86400,
  perOrderQuantity: 1,
  description: '<p>每日坚果，三人成团。</p>',
  skus: [
    {
      skuId: '21',
      specText: '混合装|1000g',
      specValues: { 口味: '混合装', 规格: '1000g' },
      imageUrl: 'https://cdn.example.com/sku/21.jpg',
      price: '59.00',
      originalPrice: '88.00',
      stock: 200,
    },
  ],
  myOpenGroupId: null,
  myOpenGroupRole: null,
};

export const groupbuyOpenGroupExample: GroupbuyOpenGroup = {
  groupId: '501',
  leaderNickname: '小*',
  leaderAvatarUrl: 'https://cdn.example.com/u/101.jpg',
  seatsTotal: 3,
  seatsTaken: 2,
  seatsLeft: 1,
  expiresAt: '2026-09-23T10:00:00+08:00',
};

export const groupbuyGroupViewExample: GroupbuyGroupView = {
  groupId: '501',
  activityId: '1',
  title: '三人成团 · 坚果礼盒',
  imageUrl: 'https://cdn.example.com/p/11.jpg',
  price: '59.00',
  status: 'forming',
  seatsTotal: 3,
  seatsTaken: 2,
  seatsLeft: 1,
  expiresAt: '2026-09-23T10:00:00+08:00',
  succeededAt: null,
  members: [
    {
      nickname: '小*',
      avatarUrl: 'https://cdn.example.com/u/101.jpg',
      role: 'leader',
      isMe: false,
    },
    {
      nickname: '小*',
      avatarUrl: 'https://cdn.example.com/u/102.jpg',
      role: 'member',
      isMe: true,
    },
  ],
  me: { role: 'member', status: 'joined', orderId: '7002', paid: true },
  canJoin: false,
};

export const myGroupbuyItemExample: MyGroupbuyItem = {
  groupId: '501',
  activityId: '1',
  title: '三人成团 · 坚果礼盒',
  imageUrl: 'https://cdn.example.com/p/11.jpg',
  status: 'forming',
  role: 'member',
  memberStatus: 'joined',
  orderId: '7002',
  seatsTotal: 3,
  seatsTaken: 2,
  expiresAt: '2026-09-23T10:00:00+08:00',
  createdAt: '2026-09-22T10:20:00+08:00',
};

export const groupbuyPosterExample: GroupbuyPoster = {
  groupId: '501',
  title: '三人成团 · 坚果礼盒',
  imageUrl: 'https://cdn.example.com/p/11.jpg',
  price: '59.00',
  originalPrice: '88.00',
  seatsLeft: 1,
  expiresAt: '2026-09-23T10:00:00+08:00',
  leaderNickname: '小*',
  leaderAvatarUrl: 'https://cdn.example.com/u/101.jpg',
  qrPayload: 'packages/promo/groupbuy-team/index?id=501',
  page: 'packages/promo/groupbuy-team/index?id=501',
  route: { route: 'groupbuyTeam', params: { id: '501' } },
};

export const groupbuyActivityStatExample: GroupbuyActivityStat = {
  activityId: '1',
  title: '三人成团 · 坚果礼盒',
  status: 'active',
  groups: 18,
  succeededGroups: 12,
  failedGroups: 2,
  formingGroups: 4,
  paidMembers: 40,
  paidAmount: '2360.00',
  refundedMembers: 2,
};

export const groupbuyActivityOrderExample: GroupbuyActivityOrder = {
  orderId: '7002',
  orderNo: '202609221000000000000002',
  groupId: '501',
  userId: '102',
  nickname: '小红',
  role: 'member',
  memberStatus: 'joined',
  groupStatus: 'forming',
  quantity: 1,
  payableAmount: '59.00',
  paid: true,
  createdAt: '2026-09-22T10:20:00+08:00',
};

// ---------------------------------------------------------------------------
// 人气条
// ---------------------------------------------------------------------------

/**
 * The strip at the top of the 拼团 tab: 「已有 N 人参与拼团」 and a row of faces.
 *
 * `participants` is **distinct users currently taking part**, not a count of
 * join rows: counting rows, with refunds, failed teams and repeat joins
 * included, only ever goes up and soon exceeds the shop's customer count. A
 * participant is a member who has not left, in a team that is still forming or
 * has already succeeded, on an activity that is live right now.
 */
export const groupbuySummary = z.object({
  /** Distinct users in a live team. Never negative, and it can go down. */
  participants: z.number().int().min(0),
  /**
   * Up to `GROUPBUY_SUMMARY_AVATAR_LIMIT` faces, most recent participant first.
   * Fewer than that — including none — is ordinary: a shop that has just opened
   * its first activity has no faces yet, and members may have no avatar at all.
   */
  avatars: z.array(z.string()).max(8),
});
export type GroupbuySummary = z.infer<typeof groupbuySummary>;

/** How many faces the strip shows. One row on a phone. */
export const GROUPBUY_SUMMARY_AVATAR_LIMIT = 8;

export const groupbuySummaryExample: GroupbuySummary = {
  participants: 1286,
  avatars: [
    'https://cdn.example.com/avatar/1.png',
    'https://cdn.example.com/avatar/2.png',
    'https://cdn.example.com/avatar/3.png',
  ],
};
