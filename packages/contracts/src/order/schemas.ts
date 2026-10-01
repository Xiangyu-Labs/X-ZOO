import { z } from 'zod';
import { id, instant, money, pageQuery, paged, sortQuery } from '../_conventions/common';
import { productKind } from '../cart/schemas';

/**
 * Checkout and order shapes.
 *
 * Three families live here:
 *
 *  - the **draft** the shopper is looking at (`checkoutPreview*`), which is
 *    recomputed on the server on every call and never trusted from the client;
 *  - the **order** itself (`orderDetail`, `orderListItem`);
 *  - the **create** body, which is the preview's input plus an idempotency key.
 *
 * The create body deliberately repeats the preview body instead of carrying a
 * "preview token": the server recomputes everything either way, and a token
 * would only be a place for a stale price to hide. What the client *may* send
 * is `expectedPayableAmount` — see `checkoutCreateBody`.
 */

// ---------------------------------------------------------------------------
// enums (hand-copied from the PostgreSQL enums; the service asserts they match)
// ---------------------------------------------------------------------------

/** Mirrors `orders_status`. */
export const orderStatus = z.enum([
  'pending_payment',
  'paid',
  'shipped',
  'received',
  'completed',
  'cancelled',
  'refunded',
]);
export type OrderStatus = z.infer<typeof orderStatus>;

/** Mirrors `orders_fulfillment_status`. Only fulfilment moves it; checkout never does. */
export const orderFulfillmentStatus = z.enum(['unfulfilled', 'partially_fulfilled', 'fulfilled']);
export type OrderFulfillmentStatus = z.infer<typeof orderFulfillmentStatus>;

/** Mirrors `orders_refund_status`. */
export const orderRefundStatus = z.enum(['none', 'requested', 'partially_refunded', 'refunded']);
export type OrderRefundStatus = z.infer<typeof orderRefundStatus>;

/** Mirrors `orders_kind`. `groupbuy` and `presale` are driven by their `OrderKindHandler`. */
export const orderKind = z.enum(['normal', 'groupbuy', 'presale']);
export type OrderKind = z.infer<typeof orderKind>;

/** Who asked for the cancellation. Mirrors the `OrderCancelledEvent.reason` union in ports.ts. */
export const orderCancelReason = z.enum(['user', 'timeout', 'admin', 'payment-failed']);
export type OrderCancelReason = z.infer<typeof orderCancelReason>;

// ---------------------------------------------------------------------------
// checkout preview
// ---------------------------------------------------------------------------

/**
 * Where the lines come from.
 *
 * `cart` prices the ticked rows (or the named subset); `buy-now` prices one
 * variant that never entered the cart. 立即购买 is not a hidden cart row that
 * has to be remembered and deleted: the two are one union and nothing is
 * written until the order is created.
 */
export const checkoutSource = z.enum(['cart', 'buy-now']);
export type CheckoutSource = z.infer<typeof checkoutSource>;

/**
 * What both `preview` and `create` need to know, apart from the order kind.
 * Kept as a plain object so `create` can extend it; the kind and the
 * cross-field rule are attached to each of the two exported schemas, because
 * an intersected or `.refine()`d schema can no longer be extended.
 */
const checkoutInput = z.object({
  source: checkoutSource.default('cart'),
  /** `source: 'cart'` — the rows to price. Empty means "every ticked, available row". */
  cartItemIds: z.array(id).max(200).default([]),
  /** `source: 'buy-now'` — the single variant being bought. */
  item: z.object({ skuId: id, quantity: z.number().int().min(1).max(9999) }).optional(),
  /** Omit for the shopper's default address; `null` explicitly prices without one. */
  addressId: id.nullish(),
  /** The coupon the shopper picked in `/api/v1/user-coupons/applicable`. */
  userCouponId: id.nullish(),
});

/**
 * An activity or team id inside `kindMeta`.
 *
 * A decimal string like every other id, and — only here — a positive integer
 * too, normalised to the string. `kindMeta` was an untyped record until the
 * mini-program rewrite, and the kind handlers read it with `Number(…)`, so a
 * number used to work; typing the field must not start refusing it.
 */
const kindMetaId = z.union([
  id,
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String),
]);

/** `kind: 'groupbuy'` — the activity, and the team to join (absent opens a new team, 开团). */
export const groupbuyKindMeta = z.object({
  activityId: kindMetaId,
  groupId: kindMetaId.optional(),
});
export type GroupbuyKindMeta = z.infer<typeof groupbuyKindMeta>;

/** `kind: 'presale'` — the activity whose deposit price and quota apply. */
export const presaleKindMeta = z.object({ activityId: kindMetaId });
export type PresaleKindMeta = z.infer<typeof presaleKindMeta>;

/**
 * The order kind and its payload, one discriminated union on `kind` (ORDER-009).
 *
 * The wire names are the ones the untyped `kindMeta` record always had, so the
 * legacy client's `{ kind: 'groupbuy', kindMeta: { activityId: '12', groupId:
 * '7' } }` parses unchanged. What changed:
 *
 * - `groupbuy` and `presale` must carry their `kindMeta`; the handler refused an
 *   order without `activityId` anyway, now the preview refuses it too;
 * - keys a kind does not declare are **stripped**, not passed on. The order
 *   domain hands `kindMeta` to the pricing contributors next to `kind`, and a
 *   stray `kind` inside it used to be able to overrule the real one;
 * - `normal` accepts and discards whatever `kindMeta` a client sends, which is
 *   what the order domain always did with it.
 */
export const checkoutKind = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('normal').default('normal'),
    kindMeta: z
      .unknown()
      .optional()
      .transform(() => undefined)
      .optional(),
  }),
  z.object({ kind: z.literal('groupbuy'), kindMeta: groupbuyKindMeta }),
  z.object({ kind: z.literal('presale'), kindMeta: presaleKindMeta }),
]);
export type CheckoutKind = z.infer<typeof checkoutKind>;

const buyNowNeedsAnItem = {
  check: (body: { source: CheckoutSource; item?: unknown }) =>
    body.source !== 'buy-now' || body.item !== undefined,
  message: '立即购买需要指定商品',
  path: ['item'] as const,
};

export const checkoutPreviewBody = checkoutInput.and(checkoutKind).refine(buyNowNeedsAnItem.check, {
  message: buyNowNeedsAnItem.message,
  path: [...buyNowNeedsAnItem.path],
});
export type CheckoutPreviewBody = z.infer<typeof checkoutPreviewBody>;

/** The receiver snapshot as the preview and the order both show it. */
export const orderReceiver = z.object({
  addressId: id.nullable(),
  name: z.string(),
  phone: z.string(),
  province: z.string(),
  city: z.string(),
  district: z.string().nullable(),
  detail: z.string(),
  postCode: z.string().nullable(),
});
export type OrderReceiver = z.infer<typeof orderReceiver>;

export const orderReceiverExample = {
  addressId: '301',
  name: '张三',
  phone: '13800138000',
  province: '浙江省',
  city: '杭州市',
  district: '西湖区',
  detail: '文三路 100 号 3 单元 501',
  postCode: '310012',
} satisfies OrderReceiver;

/**
 * One priced line.
 *
 * `discountAmount` is this line's exact share of `couponDiscount` — the shares
 * are split with `Money.allocate`, so they always add back up to the order
 * total and a later partial refund never has to re-prorate.
 */
export const checkoutLine = z.object({
  /** Stable key within the order. Becomes `order_items.item_key`. */
  itemKey: z.string(),
  productId: id,
  skuId: id,
  /** Present when the line came from the cart, so the client can tick it off. */
  cartItemId: id.nullable(),
  productName: z.string(),
  productImageUrl: z.string(),
  productKind,
  skuImageUrl: z.string().nullable(),
  specText: z.string(),
  unitName: z.string().nullable(),
  quantity: z.number().int().min(1),
  unitPrice: money,
  originalUnitPrice: money.nullable(),
  /** `unitPrice * quantity`, before any discount. */
  subtotal: money,
  discountAmount: money,
  /** `subtotal - discountAmount`. Becomes `order_items.total_amount`. */
  totalAmount: money,
});
export type CheckoutLine = z.infer<typeof checkoutLine>;

export const checkoutLineExample = {
  itemKey: 'sku-21',
  productId: '11',
  skuId: '21',
  cartItemId: '5001',
  productName: '有机三只松鼠坚果礼盒',
  productImageUrl: 'https://cdn.example.com/p/11.jpg',
  productKind: 'physical',
  skuImageUrl: 'https://cdn.example.com/sku/21.jpg',
  specText: '混合装|1000g',
  unitName: '盒',
  quantity: 2,
  unitPrice: '60.00',
  originalUnitPrice: '88.00',
  subtotal: '120.00',
  discountAmount: '10.00',
  totalAmount: '110.00',
} satisfies CheckoutLine;

/**
 * One line of the 优惠明细 panel: what a marketing rule took off and why.
 *
 * Produced by the `PricingContributor`s in `core/src/order/ports.ts` plus the
 * coupon, in the order they were applied. `amount` is negative for a discount.
 */
export const priceAdjustment = z.object({
  /** `<domain>:<rule>`, e.g. `coupon:full-reduction`. */
  source: z.string(),
  label: z.string(),
  amount: z.string().regex(/^-?(0|[1-9]\d{0,9})\.\d{2}$/, '金额格式不正确'),
});
export type PriceAdjustment = z.infer<typeof priceAdjustment>;

export const checkoutPreview = z.object({
  lines: z.array(checkoutLine),
  receiver: orderReceiver.nullable(),
  /** True when any line is physical, i.e. an address is required to create the order. */
  addressRequired: z.boolean(),
  totalQuantity: z.number().int().min(1),
  /** Sum of the line subtotals. Becomes `orders.items_amount`. */
  itemsAmount: money,
  freightAmount: money,
  /**
   * Every goods-level discount added together: the coupon plus each
   * `PricingContributor`. It is what `orders.coupon_discount` stores and what
   * the per-line `discountAmount`s sum to. The name is the column's; it holds
   * more than the coupon.
   */
  couponDiscount: money,
  adjustments: z.array(priceAdjustment),
  /** `itemsAmount + freightAmount - couponDiscount`, floored at zero. */
  payableAmount: money,
  /** Echoed back so the client can tell a rejected coupon from an accepted one. */
  userCouponId: id.nullable(),
  /** Minutes the shopper will have to pay once the order exists. */
  payWindowMinutes: z.number().int().min(1),
  /**
   * 预售: the order ships within this many days of being paid in full (付款后 N 天内发货;
   * `0` = as soon as it can). The campaign's current setting — the promise is stamped at
   * payment. `null` for every other kind.
   */
  shipAfterDays: z.number().int().min(0).nullable(),
  /** Answers the buyer must fill in, copied from `products.custom_form`. */
  customFormFields: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        type: z.enum([
          'text',
          'textarea',
          'number',
          'date',
          'select',
          'radio',
          'checkbox',
          'image',
        ]),
        required: z.boolean(),
        options: z.array(z.string()).optional(),
        placeholder: z.string().optional(),
      }),
    )
    .default([]),
});
export type CheckoutPreview = z.infer<typeof checkoutPreview>;

export const checkoutPreviewExample = {
  lines: [checkoutLineExample],
  receiver: orderReceiverExample,
  addressRequired: true,
  totalQuantity: 2,
  itemsAmount: '120.00',
  freightAmount: '8.00',
  couponDiscount: '10.00',
  adjustments: [{ source: 'coupon:full-reduction', label: '满 100 减 10', amount: '-10.00' }],
  payableAmount: '118.00',
  userCouponId: '9001',
  payWindowMinutes: 30,
  shipAfterDays: null,
  customFormFields: [],
} satisfies CheckoutPreview;

// ---------------------------------------------------------------------------
// order creation
// ---------------------------------------------------------------------------

export const checkoutCreateBody = checkoutInput
  .extend({
    /**
     * Client-generated, unique per submit attempt. A second POST with the same
     * key returns the order the first one created instead of creating another.
     *
     * It is a uniqueness constraint in the same transaction as the order, not a
     * lock in a cache, so it survives a restart and a double tap cannot slip
     * between check and insert.
     */
    idempotencyKey: z
      .string()
      .min(8)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, '幂等键格式不正确'),
    buyerRemark: z.string().max(512).optional(),
    /** Answers to `products.custom_form`, keyed by field. */
    customForm: z.record(z.string(), z.unknown()).optional(),
    /**
     * What the shopper was shown. When present and the server's recomputation
     * disagrees, the order is refused with `ORDER_PRICE_CHANGED` instead of
     * charging a price nobody agreed to (say, an operator edited the SKU
     * between confirm and create).
     */
    expectedPayableAmount: money.optional(),
  })
  .and(checkoutKind)
  .refine(buyNowNeedsAnItem.check, {
    message: buyNowNeedsAnItem.message,
    path: [...buyNowNeedsAnItem.path],
  });
export type CheckoutCreateBody = z.infer<typeof checkoutCreateBody>;

// ---------------------------------------------------------------------------
// orders
// ---------------------------------------------------------------------------

export const orderItem = z.object({
  id,
  itemKey: z.string(),
  productId: id,
  skuId: id,
  productName: z.string(),
  productImageUrl: z.string(),
  productKind,
  specText: z.string(),
  skuImageUrl: z.string().nullable(),
  unitName: z.string().nullable(),
  quantity: z.number().int().min(1),
  unitPrice: money,
  originalUnitPrice: money.nullable(),
  /**
   * This line's share of `couponDiscount`: every goods-level discount, the
   * coupon and each activity price alike. `adjustments` says which.
   */
  discountAmount: money,
  totalAmount: money,
  refundedQuantity: z.number().int().min(0),
  shippedQuantity: z.number().int().min(0),
  /**
   * What each checkout rule took off this line, in the order applied — the
   * preview's `adjustments`, split per line and kept with the order. An
   * activity price (`presale:activity-price`, `groupbuy:activity-price`) and a
   * stacked coupon (`coupon:*`) are separate entries, so the price the shopper
   * paid per unit is `unitPrice` less the activity entries over `quantity`.
   * Sums to `-discountAmount`, unless an operator 改价'd the order (the
   * difference is theirs). Empty for a line written before per-line adjustments
   * were kept.
   */
  adjustments: z.array(priceAdjustment),
});
export type OrderItem = z.infer<typeof orderItem>;

export const orderItemExample = {
  id: '7001',
  itemKey: 'sku-21',
  productId: '11',
  skuId: '21',
  productName: '有机三只松鼠坚果礼盒',
  productImageUrl: 'https://cdn.example.com/p/11.jpg',
  productKind: 'physical',
  specText: '混合装|1000g',
  skuImageUrl: 'https://cdn.example.com/sku/21.jpg',
  unitName: '盒',
  quantity: 2,
  unitPrice: '60.00',
  originalUnitPrice: '88.00',
  discountAmount: '10.00',
  totalAmount: '110.00',
  refundedQuantity: 0,
  shippedQuantity: 0,
  adjustments: [{ source: 'coupon:full-reduction', label: '满 100 减 10', amount: '-10.00' }],
} satisfies OrderItem;

export const orderListItem = z.object({
  id,
  orderNo: z.string(),
  kind: orderKind,
  status: orderStatus,
  fulfillmentStatus: orderFulfillmentStatus,
  refundStatus: orderRefundStatus,
  totalQuantity: z.number().int().min(1),
  itemsAmount: money,
  freightAmount: money,
  couponDiscount: money,
  payableAmount: money,
  paidAmount: money.nullable(),
  /** `null` once the order left `pending_payment`. The client counts down to it. */
  payExpiresAt: instant.nullable(),
  createdAt: instant,
  items: z.array(orderItem),
});
export type OrderListItem = z.infer<typeof orderListItem>;

export const orderListItemExample = {
  id: '9001',
  orderNo: '202602011000000010123456',
  kind: 'normal',
  status: 'pending_payment',
  fulfillmentStatus: 'unfulfilled',
  refundStatus: 'none',
  totalQuantity: 2,
  itemsAmount: '120.00',
  freightAmount: '8.00',
  couponDiscount: '10.00',
  payableAmount: '118.00',
  paidAmount: null,
  payExpiresAt: '2026-02-01T10:30:00+08:00',
  createdAt: '2026-02-01T10:00:00+08:00',
  items: [orderItemExample],
} satisfies OrderListItem;

/**
 * A line as the shopper's own 我的订单 and 订单详情 show it: `orderItem` plus its review state,
 * so the 评价 page and the 去评价 button need not learn it from a refusal. The console reads
 * the plain `orderItem`.
 *
 * `reviewable` is exactly what `catalog.reviewSubmit` accepts (ORDER-010): the order is
 * `received` or `completed`, the line is not refunded in full, and it has no review yet.
 * There is no deadline: `autoReviewDays` after completion the auto-review job writes the
 * default review, and from then on the line is `reviewed`.
 */
export const storefrontOrderItem = orderItem.extend({
  /**
   * The line has a review — published, 待审核 (held for moderation) or removed by the shop.
   * A second one is refused (`CATALOG_REVIEW_ALREADY_WRITTEN`) in every case.
   */
  reviewed: z.boolean(),
  /** A review can be written for this line now. */
  reviewable: z.boolean(),
});
export type StorefrontOrderItem = z.infer<typeof storefrontOrderItem>;

export const storefrontOrderItemExample = {
  ...orderItemExample,
  reviewed: false,
  reviewable: false,
} satisfies StorefrontOrderItem;

/**
 * 拼团: where the order's team stands, so 我的订单 and 订单详情 can say 拼团中 instead of
 * 待发货 while the team is still forming (a group-buy order ships only once its team has
 * succeeded, RISK-D-011). `role` is this order's own seat — the leader of a team the
 * shopper joined is somebody else.
 */
export const orderGroupbuyTeam = z.object({
  id,
  /**
   * `groupbuyGroupStatus` and `groupbuyMemberRole`, spelled out: `groupbuy/schemas` imports
   * the storefront route catalogue, which imports this file.
   */
  status: z.enum(['forming', 'succeeded', 'failed', 'cancelled']),
  role: z.enum(['leader', 'member']),
  seatsTotal: z.number().int().min(2),
  seatsTaken: z.number().int().min(0),
  expiresAt: instant,
});
export type OrderGroupbuyTeam = z.infer<typeof orderGroupbuyTeam>;

/** The shopper's list row: `orderListItem` with `storefrontOrderItem` lines. */
export const storefrontOrderListItem = orderListItem.extend({
  items: z.array(storefrontOrderItem),
  /** Every refund that has succeeded, added up (`orders.refunded_amount`). */
  refundedAmount: money,
  /**
   * An after-sales request on the order is still being handled (申请中, 已同意, 退款中, or
   * refused by WeChat and waiting for the merchant): 售后中. `refundStatus` cannot say it —
   * that roll-up stays `partially_refunded` once any money went back, open request or not.
   */
  hasOpenRefund: z.boolean(),
  /** 拼团 orders only; `null` for every other kind. */
  groupbuyTeam: orderGroupbuyTeam.nullable(),
});
export type StorefrontOrderListItem = z.infer<typeof storefrontOrderListItem>;

export const storefrontOrderListItemExample = {
  ...orderListItemExample,
  items: [storefrontOrderItemExample],
  refundedAmount: '0.00',
  hasOpenRefund: false,
  groupbuyTeam: null,
} satisfies StorefrontOrderListItem;

export const orderDetail = storefrontOrderListItem.extend({
  receiver: orderReceiver,
  buyerRemark: z.string().nullable(),
  customForm: z.record(z.string(), z.unknown()).nullable(),
  userCouponId: id.nullable(),
  paidAt: instant.nullable(),
  shippedAt: instant.nullable(),
  receivedAt: instant.nullable(),
  completedAt: instant.nullable(),
  cancelledAt: instant.nullable(),
  cancelReason: z.string().nullable(),
  /**
   * 拼团: the team this order sits in, for 查看拼团 (`groupbuyTeam { id }`). Set from the
   * moment the order exists — 开团 creates the team with the order, 参团 names it — and kept
   * after a cancel or refund (the team page shows how it ended). `null` for any other kind.
   */
  groupbuyTeamId: id.nullable(),
  /**
   * 申请开票 is open: paid, not refunded in full, something left to invoice and no request
   * already 待开票 or 已开票 — exactly what `order.invoiceRequest` accepts.
   */
  invoiceRequestable: z.boolean(),
  /** What an invoice would be made out for: paid less refunded (`0.00` before payment). */
  invoiceAmount: money,
});
export type OrderDetail = z.infer<typeof orderDetail>;

export const orderDetailExample = {
  ...storefrontOrderListItemExample,
  receiver: orderReceiverExample,
  buyerRemark: '请在工作日送达',
  customForm: null,
  userCouponId: '9001',
  paidAt: null,
  shippedAt: null,
  receivedAt: null,
  completedAt: null,
  cancelledAt: null,
  cancelReason: null,
  groupbuyTeamId: null,
  invoiceRequestable: false,
  invoiceAmount: '0.00',
} satisfies OrderDetail;

/**
 * The storefront's 我的订单 tabs. They are not `orders.status` values: 待收货
 * covers `shipped`, and 已完成 covers both `received` and `completed`, exactly
 * as the storefront's tab bar has always shown them.
 */
export const orderListTab = z.enum([
  'all',
  'unpaid',
  'unshipped',
  'shipping',
  'unreceived',
  'finished',
  'cancelled',
  'refunding',
  /**
   * 待评价: a `received` or `completed` order with at least one `reviewable` line
   * (`storefrontOrderItem`, ORDER-010). A subset of 已完成; the order leaves it when its last
   * line is reviewed — by the shopper, or by the auto-review job `autoReviewDays` after
   * completion.
   */
  'unreviewed',
]);
export type OrderListTab = z.infer<typeof orderListTab>;

export const orderListQuery = pageQuery
  .extend({
    tab: orderListTab.default('all'),
    /** Order number or product name substring. */
    keyword: z.string().trim().max(64).optional(),
  })
  .extend(sortQuery(['createdAt', 'payableAmount']).shape);
export type OrderListQuery = z.infer<typeof orderListQuery>;

export const pagedOrders = paged(storefrontOrderListItem);

/** The badge numbers on the tab bar. One query, not nine. */
export const orderCounts = z.object({
  all: z.number().int().min(0),
  unpaid: z.number().int().min(0),
  unshipped: z.number().int().min(0),
  unreceived: z.number().int().min(0),
  finished: z.number().int().min(0),
  cancelled: z.number().int().min(0),
  refunding: z.number().int().min(0),
  /** 待评价, the `unreviewed` tab's orders (ORDER-010). Also counted in `finished`. */
  unreviewed: z.number().int().min(0),
});
export type OrderCounts = z.infer<typeof orderCounts>;

export const orderCountsExample = {
  all: 12,
  unpaid: 1,
  unshipped: 2,
  unreceived: 3,
  finished: 5,
  cancelled: 1,
  refunding: 0,
  unreviewed: 2,
} satisfies OrderCounts;

export const orderCancelBody = z.object({
  /** Free text the buyer typed, shown in the order timeline. */
  reason: z.string().max(255).optional(),
});
export type OrderCancelBody = z.infer<typeof orderCancelBody>;

/**
 * The answer to 删除订单.
 *
 * A single `true`, and not the order: the row the buyer just asked to stop
 * seeing is the one thing this response has no business handing back. The page
 * drops it from the list and moves on.
 */
export const orderHidden = z.object({
  hidden: z.literal(true),
});
export type OrderHidden = z.infer<typeof orderHidden>;

/** Only these three may be hidden; anything else is still in flight. */
export const HIDEABLE_ORDER_STATUSES = ['completed', 'cancelled', 'refunded'] as const;
