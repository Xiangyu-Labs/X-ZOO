import { z } from 'zod';
import { id, idList, instant, money, pageQuery, paged, sortQuery } from '../_conventions/common';
import { adminUserListQuery } from '../user/schemas';

/**
 * Shapes shared by the coupon routes.
 *
 * The enums are the PostgreSQL enums of `db/src/schema/coupon.ts`, spelled the
 * same way. They are *not* imported from `@shop/db` — contracts are the bottom
 * layer and may not depend on the database package — so the pair is kept honest
 * by `coupon.service.ts`, which assigns one to the other and would fail to
 * compile if they drifted.
 *
 * There is no 会员券 kind: the shop has no paid membership.
 */

// ---------------------------------------------------------------------------
// enums
// ---------------------------------------------------------------------------

/** What the coupon may be spent on. */
export const couponScope = z.enum(['all_products', 'categories', 'products']);
export type CouponScope = z.infer<typeof couponScope>;

/** How a user comes to hold one. Only `manual` is claimable by the shopper. */
export const couponClaimMode = z.enum(['manual', 'new_user', 'order_gift', 'admin_grant']);
export type CouponClaimMode = z.infer<typeof couponClaimMode>;

/** How the coupon's own validity window is worked out. */
export const couponValidityMode = z.enum(['fixed_window', 'days_after_claim']);
export type CouponValidityMode = z.infer<typeof couponValidityMode>;

export const couponTemplateStatus = z.enum(['draft', 'active', 'disabled']);
export type CouponTemplateStatus = z.infer<typeof couponTemplateStatus>;

export const userCouponStatus = z.enum(['unused', 'used', 'expired', 'revoked']);
export type UserCouponStatus = z.infer<typeof userCouponStatus>;

/** Where a wallet coupon came from. */
export const userCouponSourceKind = z.enum(['claim', 'gift_order', 'gift_new_user', 'admin_grant']);
export type UserCouponSourceKind = z.infer<typeof userCouponSourceKind>;

// ---------------------------------------------------------------------------
// admin: templates
// ---------------------------------------------------------------------------

/**
 * One row of the admin template list. Deliberately without the product and
 * category id lists: the list renders 20 of these and neither is shown in a
 * column, so fetching them would be 40 round trips for nothing. The detail
 * route carries them.
 */
export const couponTemplateListItem = z.object({
  id,
  name: z.string(),
  scope: couponScope,
  claimMode: couponClaimMode,
  status: couponTemplateStatus,
  discountAmount: money,
  minSpend: money,
  validityMode: couponValidityMode,
  validFrom: instant.nullable(),
  validTo: instant.nullable(),
  validDays: z.number().int().nullable(),
  claimFrom: instant.nullable(),
  claimTo: instant.nullable(),
  isUnlimitedSupply: z.boolean(),
  totalCount: z.number().int().nullable(),
  remainingCount: z.number().int().nullable(),
  /** How many `user_coupons` rows this template has issued, of any status. */
  issuedCount: z.number().int().min(0),
  perUserLimit: z.number().int().nullable(),
  giftMinOrderAmount: money.nullable(),
  sortOrder: z.number().int(),
  createdAt: instant,
});
export type CouponTemplateListItem = z.infer<typeof couponTemplateListItem>;

/** The list item plus the scope links, for the edit form. */
export const couponTemplateDetail = couponTemplateListItem.extend({
  /** Non-empty only when `scope = 'products'`. */
  productIds: z.array(id),
  /** Non-empty only when `scope = 'categories'`. */
  categoryIds: z.array(id),
});
export type CouponTemplateDetail = z.infer<typeof couponTemplateDetail>;

/**
 * Create / update body.
 *
 * The three `superRefine` rules mirror `coupon_templates_validity_shape`,
 * `coupon_templates_supply_shape` and the scope links: a form that cannot reach
 * the database is a 422 with a field error, not a 500 from a CHECK violation.
 * `ZodForm` runs the same schema in the browser, so the operator sees the same
 * message before the request leaves.
 */
export const couponTemplateForm = z
  .object({
    name: z.string().min(1).max(64),
    scope: couponScope,
    claimMode: couponClaimMode,
    /**
     * Create and update both carry the full status, so editing a paused
     * campaign does not silently re-enable it. `POST /:id/status` is the
     * one-click toggle from the list; this is the considered one from the form.
     */
    status: couponTemplateStatus.default('draft'),
    discountAmount: money,
    minSpend: money.default('0.00'),
    validityMode: couponValidityMode,
    /** `fixed_window` only. */
    validFrom: instant.optional(),
    validTo: instant.optional(),
    /** `days_after_claim` only. */
    validDays: z.number().int().min(1).max(3650).optional(),
    claimFrom: instant.optional(),
    claimTo: instant.optional(),
    isUnlimitedSupply: z.boolean().default(false),
    /** Required unless `isUnlimitedSupply`. On update this is the new *total*; see the service. */
    totalCount: z.number().int().min(1).max(10_000_000).optional(),
    perUserLimit: z.number().int().min(1).max(1000).optional(),
    /** `order_gift` only: the paid amount that earns the coupon. Omitted = every paid order. */
    giftMinOrderAmount: money.optional(),
    sortOrder: z.number().int().min(0).max(9999).default(0),
    productIds: z.array(id).max(500).default([]),
    categoryIds: z.array(id).max(200).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.validityMode === 'fixed_window') {
      if (!value.validFrom) {
        ctx.addIssue({ code: 'custom', path: ['validFrom'], message: '请选择有效期开始时间' });
      }
      if (!value.validTo) {
        ctx.addIssue({ code: 'custom', path: ['validTo'], message: '请选择有效期结束时间' });
      }
      if (value.validFrom && value.validTo && value.validTo <= value.validFrom) {
        ctx.addIssue({ code: 'custom', path: ['validTo'], message: '结束时间必须晚于开始时间' });
      }
      if (value.validDays !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['validDays'], message: '固定有效期不需要填写天数' });
      }
    } else {
      if (value.validDays === undefined) {
        ctx.addIssue({ code: 'custom', path: ['validDays'], message: '请填写领取后的有效天数' });
      }
      if (value.validFrom !== undefined || value.validTo !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['validFrom'],
          message: '领取后计算有效期时不填日期',
        });
      }
    }

    if (value.isUnlimitedSupply) {
      if (value.totalCount !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['totalCount'], message: '不限量时不需要填写数量' });
      }
    } else if (value.totalCount === undefined) {
      ctx.addIssue({ code: 'custom', path: ['totalCount'], message: '请填写发放数量' });
    }

    if (value.claimFrom && value.claimTo && value.claimTo <= value.claimFrom) {
      ctx.addIssue({ code: 'custom', path: ['claimTo'], message: '领取结束时间必须晚于开始时间' });
    }

    if (value.scope === 'products' && value.productIds.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['productIds'], message: '请选择适用商品' });
    }
    if (value.scope === 'categories' && value.categoryIds.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['categoryIds'], message: '请选择适用分类' });
    }
    if (value.scope !== 'products' && value.productIds.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['productIds'], message: '当前适用范围不需要选择商品' });
    }
    if (value.scope !== 'categories' && value.categoryIds.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['categoryIds'],
        message: '当前适用范围不需要选择分类',
      });
    }
  });
export type CouponTemplateForm = z.infer<typeof couponTemplateForm>;

export const couponTemplateListQuery = pageQuery
  .extend({
    keyword: z.string().trim().max(64).optional(),
    status: z.union([couponTemplateStatus, z.array(couponTemplateStatus)]).optional(),
    scope: couponScope.optional(),
    claimMode: couponClaimMode.optional(),
  })
  .extend(sortQuery(['id', 'name', 'discountAmount', 'sortOrder', 'createdAt']).shape);
export type CouponTemplateListQuery = z.infer<typeof couponTemplateListQuery>;

export const pagedCouponTemplates = paged(couponTemplateListItem);

/** Enable / disable. Draft → active is the same call. */
export const couponTemplateStatusBody = z.object({
  status: z.enum(['active', 'disabled']),
});
export type CouponTemplateStatusBody = z.infer<typeof couponTemplateStatusBody>;

/** Hand a template to named users. The template need not be `manual`. */
export const couponGrantBody = z.object({
  userIds: z.array(id).min(1).max(200),
});
export type CouponGrantBody = z.infer<typeof couponGrantBody>;

export const couponGrantResult = z.object({
  /** How many `user_coupons` rows this call created. */
  granted: z.number().int().min(0),
  /** Users who already held the maximum for this template, so nothing was issued to them. */
  skippedUserIds: z.array(id),
});
export type CouponGrantResult = z.infer<typeof couponGrantResult>;

/**
 * The most users one 按筛选发放 may reach. The grant runs in one request and
 * one transaction, holding the template's row for every issue, so a bigger
 * audience is refused rather than left to time out half way.
 */
export const MAX_GRANT_AUDIENCE = 1000;

/**
 * Who a 按筛选发放 reaches: the 客户列表's filters, without its paging and
 * sorting. No filter at all is every account that is not deleted.
 */
export const couponGrantAudience = adminUserListQuery.omit({
  page: true,
  pageSize: true,
  sortBy: true,
  sortOrder: true,
});
export type CouponGrantAudience = z.infer<typeof couponGrantAudience>;

/** Hand a template to every user the 客户列表's filters match. */
export const couponGrantBatchBody = z.object({
  filter: couponGrantAudience,
});
export type CouponGrantBatchBody = z.infer<typeof couponGrantBatchBody>;

export const couponGrantBatchResult = couponGrantResult.extend({
  /** How many users the filter matched when the grant ran. */
  matched: z.number().int().min(0),
});
export type CouponGrantBatchResult = z.infer<typeof couponGrantBatchResult>;

/** 作废: `1` when this call revoked the coupon, `0` when it was no longer unused. */
export const couponRevokeResult = z.object({
  revoked: z.union([z.literal(0), z.literal(1)]),
});
export type CouponRevokeResult = z.infer<typeof couponRevokeResult>;

// ---------------------------------------------------------------------------
// user coupons (both surfaces)
// ---------------------------------------------------------------------------

/** One coupon in a wallet, as both the admin list and the storefront see it. */
export const userCoupon = z.object({
  id,
  templateId: id,
  /** Snapshot taken at issue time; the template may be renamed afterwards. */
  title: z.string(),
  discountAmount: money,
  minSpend: money,
  scope: couponScope,
  status: userCouponStatus,
  sourceKind: userCouponSourceKind,
  validFrom: instant,
  validTo: instant,
  usedAt: instant.nullable(),
  createdAt: instant,
});
export type UserCoupon = z.infer<typeof userCoupon>;

/** The admin list adds who holds it. */
export const adminUserCoupon = userCoupon.extend({
  userId: id,
  userNickname: z.string().nullable(),
  /** Set for `gift_order`: the paid order that earned this coupon. */
  sourceOrderId: id.nullable(),
});
export type AdminUserCoupon = z.infer<typeof adminUserCoupon>;

export const adminUserCouponListQuery = pageQuery
  .extend({
    templateId: id.optional(),
    userId: id.optional(),
    status: z.union([userCouponStatus, z.array(userCouponStatus)]).optional(),
  })
  .extend(sortQuery(['id', 'createdAt', 'validTo']).shape);
export type AdminUserCouponListQuery = z.infer<typeof adminUserCouponListQuery>;

export const pagedAdminUserCoupons = paged(adminUserCoupon);

// ---------------------------------------------------------------------------
// storefront
// ---------------------------------------------------------------------------

/**
 * A template on the "领券中心" list.
 *
 * `claimedCount` / `canClaim` describe *the caller*, so they are `null` for an
 * anonymous visitor — the route is `user-optional` and an anonymous list still
 * has to render. `null`, not `false`: "cannot claim" and "we do not know who
 * you are" are different things, and the button copy differs.
 */
export const claimableCoupon = z.object({
  templateId: id,
  name: z.string(),
  discountAmount: money,
  minSpend: money,
  scope: couponScope,
  validityMode: couponValidityMode,
  validFrom: instant.nullable(),
  validTo: instant.nullable(),
  validDays: z.number().int().nullable(),
  claimTo: instant.nullable(),
  isUnlimitedSupply: z.boolean(),
  remainingCount: z.number().int().nullable(),
  perUserLimit: z.number().int().nullable(),
  claimedCount: z.number().int().min(0).nullable(),
  canClaim: z.boolean().nullable(),
});
export type ClaimableCoupon = z.infer<typeof claimableCoupon>;

export const claimableCouponListQuery = pageQuery.extend({
  /**
   * Exactly these templates, in this order — what a DIY component's 指定数据
   * saved (template ids). A template the shopper cannot claim right now —
   * paused, not 手动领取, outside its claim window, out of supply, or deleted
   * — is skipped, not an error.
   */
  ids: idList.optional(),
  /**
   * Only the templates usable on this product — the 商品详情 领券 sheet: shop-wide
   * (`all_products`), naming the product, or naming one of its categories. The
   * same scope rule the checkout applies, so a coupon listed here covers the
   * product once claimed (its threshold and validity are still checked then).
   */
  productId: id.optional(),
});
export type ClaimableCouponListQuery = z.infer<typeof claimableCouponListQuery>;
export const pagedClaimableCoupons = paged(claimableCoupon);

export const myCouponListQuery = pageQuery.extend({
  /** `unused` is what the wallet opens on. `expired` folds in revoked coupons. */
  state: z.enum(['unused', 'used', 'expired']).default('unused'),
});
export type MyCouponListQuery = z.infer<typeof myCouponListQuery>;

export const pagedMyCoupons = paged(userCoupon);

/**
 * One cart line as the checkout picker describes it.
 *
 * The server resolves each line's categories from `productId`: the catalogue is
 * the server's, and a category list the client sends would be a
 * client-controlled eligibility input for a 品类券.
 */
export const couponCartLine = z.object({
  productId: id,
  /**
   * **Ignored.** Accepted so an older client that still sends it is not
   * refused; the server looks the product's categories up itself. New clients
   * omit it.
   */
  categoryIds: z.array(id).max(50).optional(),
  /** Line total after item-level discounts: unit price × quantity. */
  amount: money,
});
export type CouponCartLine = z.infer<typeof couponCartLine>;

export const applicableCouponsBody = z.object({
  lines: z.array(couponCartLine).min(1).max(200),
});
export type ApplicableCouponsBody = z.infer<typeof applicableCouponsBody>;

/**
 * One row of the checkout picker. Unusable coupons are returned too, greyed
 * out with `reason` — hiding them is how shoppers end up asking support why
 * their coupon "disappeared".
 */
export const applicableCoupon = z.object({
  coupon: userCoupon,
  usable: z.boolean(),
  /** What this coupon would take off, `"0.00"` when it is not usable. */
  discount: money,
  /** Indexes into the request's `lines` that the coupon applies to. */
  eligibleLineIndexes: z.array(z.number().int().min(0)),
  /** A `COUPON_*` code from `errors.ts` when `usable` is false, else `null`. */
  reason: z.string().nullable(),
});
export type ApplicableCoupon = z.infer<typeof applicableCoupon>;

export const applicableCouponsResult = z.object({
  /** Usable first, then by the discount they would give, descending. */
  items: z.array(applicableCoupon),
  /** Sum of the request's line amounts, echoed so the client can check its own arithmetic. */
  subtotal: money,
});
export type ApplicableCouponsResult = z.infer<typeof applicableCouponsResult>;

export const claimResult = z.object({
  coupon: userCoupon,
  /** What is left after this claim; `null` for an unlimited template. */
  remainingCount: z.number().int().min(0).nullable(),
});
export type ClaimResult = z.infer<typeof claimResult>;

// ---------------------------------------------------------------------------
// examples
// ---------------------------------------------------------------------------

/**
 * One consistent fixture reused by every example below, so the mock server
 * tells the mini program and the admin a coherent story instead of five unrelated
 * ones.
 */
export const couponTemplateExample: CouponTemplateListItem = {
  id: '1',
  name: '满 100 减 10',
  scope: 'all_products',
  claimMode: 'manual',
  status: 'active',
  discountAmount: '10.00',
  minSpend: '100.00',
  validityMode: 'fixed_window',
  validFrom: '2026-01-01T00:00:00+08:00',
  validTo: '2026-12-31T23:59:59+08:00',
  validDays: null,
  claimFrom: '2026-01-01T00:00:00+08:00',
  claimTo: '2026-06-30T23:59:59+08:00',
  isUnlimitedSupply: false,
  totalCount: 1000,
  remainingCount: 873,
  issuedCount: 127,
  perUserLimit: 1,
  giftMinOrderAmount: null,
  sortOrder: 0,
  createdAt: '2026-01-01T10:00:00+08:00',
};

export const couponTemplateDetailExample: CouponTemplateDetail = {
  ...couponTemplateExample,
  productIds: [],
  categoryIds: [],
};

export const userCouponExample: UserCoupon = {
  id: '9001',
  templateId: '1',
  title: '满 100 减 10',
  discountAmount: '10.00',
  minSpend: '100.00',
  scope: 'all_products',
  status: 'unused',
  sourceKind: 'claim',
  validFrom: '2026-01-01T00:00:00+08:00',
  validTo: '2026-12-31T23:59:59+08:00',
  usedAt: null,
  createdAt: '2026-01-02T09:30:00+08:00',
};

export const claimableCouponExample: ClaimableCoupon = {
  templateId: '1',
  name: '满 100 减 10',
  discountAmount: '10.00',
  minSpend: '100.00',
  scope: 'all_products',
  validityMode: 'fixed_window',
  validFrom: '2026-01-01T00:00:00+08:00',
  validTo: '2026-12-31T23:59:59+08:00',
  validDays: null,
  claimTo: '2026-06-30T23:59:59+08:00',
  isUnlimitedSupply: false,
  remainingCount: 873,
  perUserLimit: 1,
  claimedCount: 0,
  canClaim: true,
};

// ---------------------------------------------------------------------------
// 订单赠券
// ---------------------------------------------------------------------------

/**
 * The coupons an order earned, in the order they were issued.
 *
 * Always a `200`. An order that earned nothing answers `{ items: [] }`, because
 * "this order came with no coupons" is a fact about the order, not a failure —
 * and the 订单详情 page asks for this on every open.
 */
export const orderGiftCoupons = z.object({
  items: z.array(userCoupon),
});
export type OrderGiftCoupons = z.infer<typeof orderGiftCoupons>;
