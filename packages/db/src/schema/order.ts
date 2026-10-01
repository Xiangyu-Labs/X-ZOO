import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { createdAt, deletedAt, fk, instant, money, pk, updatedAt } from './_shared';
import { admins } from './auth';
import { productSkus, products } from './catalog';
import { userCoupons } from './coupon';
import { cities, expressCompanies } from './reference';
import { users } from './user';

/**
 * Orders, their lines, the shipments that fulfil them, the audit log, the
 * manual invoice request and the post-payment effect ledger.
 *
 * ## Design
 *
 * * **No child orders.** An order is never split: partial shipment is a
 *   `shipments` row covering some `shipment_items`, and progress is
 *   `order_items.shipped_quantity`. Money therefore never has to be
 *   re-prorated across children.
 * * **Three orthogonal state columns.** `status` is the customer-visible
 *   lifecycle, `fulfillment_status` is the shipping progress, and
 *   `refund_status` is the after-sales roll-up. Each has one meaning.
 */

// ---------------------------------------------------------------------------
// enums
// ---------------------------------------------------------------------------

/**
 * Customer-visible lifecycle.
 *
 * ```
 * pending_payment ──pay──────► paid ──ship all──► shipped ──confirm──► received ──review/auto──► completed
 *        │                      │                                          │
 *        └──cancel/expire──► cancelled                                      │
 *                               └──────── full refund ──────► refunded ◄────┘
 * ```
 */
export const ordersStatus = pgEnum('orders_status', [
  'pending_payment',
  'paid',
  'shipped',
  'received',
  'completed',
  'cancelled',
  'refunded',
]);

/** Shipping progress. `status` only advances to `shipped` once this reaches `fulfilled`. */
export const ordersFulfillmentStatus = pgEnum('orders_fulfillment_status', [
  'unfulfilled',
  'partially_fulfilled',
  'fulfilled',
]);

/** After-sales roll-up over the order's `refunds` rows. */
export const ordersRefundStatus = pgEnum('orders_refund_status', [
  'none',
  'requested',
  'partially_refunded',
  'refunded',
]);

/** Which activity, if any, produced this order. The activity row itself lives in `groupbuy.ts` / `presale.ts`. */
export const ordersKind = pgEnum('orders_kind', ['normal', 'groupbuy', 'presale']);

/** Which storefront the order was placed from. Matches `clientPlatform` in the contracts. */
export const ordersPlatform = pgEnum('orders_platform', ['h5', 'wechat_oa', 'wechat_mini']);

// ---------------------------------------------------------------------------
// orders
// ---------------------------------------------------------------------------

export const orders = pgTable(
  'orders',
  {
    id: pk(),
    /** Customer-facing order number. The gateway's merchant order number lives on `payment_attempts`. */
    orderNo: varchar({ length: 32 }).notNull(),
    /** Client-supplied submit key; a replay returns this same order. NULL for non-storefront orders. */
    idempotencyKey: varchar({ length: 64 }),
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: ordersKind().notNull().default('normal'),
    status: ordersStatus().notNull().default('pending_payment'),
    fulfillmentStatus: ordersFulfillmentStatus().notNull().default('unfulfilled'),
    refundStatus: ordersRefundStatus().notNull().default('none'),
    platform: ordersPlatform().notNull(),

    // --- money -------------------------------------------------------------
    totalQuantity: integer().notNull(),
    /** Sum of the lines before any discount. */
    itemsAmount: money().notNull(),
    freightAmount: money().notNull().default('0.00'),
    /**
     * Every goods-level discount, not only the coupon: the coupon plus each `PricingContributor`.
     * Each line's share is `order_items.discount_amount`; refunds use the line's `total_amount`.
     */
    couponDiscount: money().notNull().default('0.00'),
    /**
     * The part of `couponDiscount` an operator added by 改价. Each 改价 replaces
     * it rather than adding to it, so 0.00 takes the last one back.
     */
    operatorDiscount: money().notNull().default('0.00'),
    /** What the buyer owes. `itemsAmount + freightAmount - couponDiscount`, unless an operator re-priced. */
    payableAmount: money().notNull(),
    /** What the gateway actually took. NULL until paid. */
    paidAmount: money(),
    /** Running total of every succeeded refund on this order. */
    refundedAmount: money().notNull().default('0.00'),
    /** Operator cost total, for the margin report. */
    costAmount: money(),
    /** The coupon spent on this order, if any. */
    userCouponId: fk().references((): AnyPgColumn => userCoupons.id, { onDelete: 'set null' }),

    // --- payment -----------------------------------------------------------
    /** The gateway transaction number of the *winning* payment. Never overwritten once set. */
    transactionNo: varchar({ length: 64 }),
    paidAt: instant(),

    // --- receiver snapshot -------------------------------------------------
    receiverName: varchar({ length: 32 }).notNull(),
    receiverPhone: varchar({ length: 20 }).notNull(),
    receiverProvince: varchar({ length: 64 }).notNull(),
    receiverCity: varchar({ length: 64 }).notNull(),
    receiverDistrict: varchar({ length: 64 }),
    receiverDetail: varchar({ length: 255 }).notNull(),
    receiverPostCode: varchar({ length: 10 }),
    /** Division id of the receiver's city, for the freight rule that priced this order. */
    receiverCityId: fk().references(() => cities.id, { onDelete: 'set null' }),

    // --- notes and timings -------------------------------------------------
    buyerRemark: varchar({ length: 512 }),
    adminRemark: varchar({ length: 512 }),
    /** Answers to `products.customForm`, keyed by field. */
    customForm: jsonb().$type<Record<string, unknown>>(),
    /** Deadline for `pending_payment`; the auto-cancel job reads it. */
    payExpiresAt: instant(),
    /** Deadline for `shipped` → `received`; the auto-confirm job reads it. */
    autoReceiveAt: instant(),
    shippedAt: instant(),
    receivedAt: instant(),
    completedAt: instant(),
    cancelledAt: instant(),
    cancelReason: varchar({ length: 255 }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** The buyer hid the order from their own list. */
    hiddenByUserAt: instant(),
    /** Admin/system soft delete. */
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('orders_order_no_uq').on(t.orderNo),
    uniqueIndex('orders_idempotency_uq')
      .on(t.userId, t.idempotencyKey)
      .where(sql`idempotency_key is not null`),
    index('orders_user_idx').on(t.userId, t.createdAt),
    index('orders_status_idx').on(t.status, t.createdAt),
    index('orders_refund_status_idx')
      .on(t.refundStatus)
      .where(sql`refund_status <> 'none'`),
    index('orders_fulfillment_idx')
      .on(t.fulfillmentStatus)
      .where(sql`status = 'paid'`),
    index('orders_created_at_idx').on(t.createdAt),
    index('orders_paid_at_idx').on(t.paidAt),
    index('orders_transaction_no_idx').on(t.transactionNo),
    index('orders_user_coupon_idx').on(t.userCouponId),
    // Auto-cancel and auto-confirm sweeps read exactly these two partial indexes.
    index('orders_pay_expires_idx')
      .on(t.payExpiresAt)
      .where(sql`status = 'pending_payment'`),
    index('orders_auto_receive_idx')
      .on(t.autoReceiveAt)
      .where(sql`status = 'shipped'`),

    check('orders_quantity_positive', sql`${t.totalQuantity} >= 1`),
    check(
      'orders_operator_discount_range',
      sql`${t.operatorDiscount} >= 0 and ${t.operatorDiscount} <= ${t.couponDiscount}`,
    ),
    check(
      'orders_amounts_non_negative',
      sql`${t.itemsAmount} >= 0 and ${t.freightAmount} >= 0 and ${t.couponDiscount} >= 0 and ${t.payableAmount} >= 0 and ${t.refundedAmount} >= 0 and (${t.paidAmount} is null or ${t.paidAmount} >= 0) and (${t.costAmount} is null or ${t.costAmount} >= 0)`,
    ),
    // REFUND-007: the sum of every succeeded refund can never exceed what was
    // actually collected. The service maintains `refunded_amount` under a
    // `SELECT … FOR UPDATE` on this row; this CHECK is the backstop.
    check(
      'orders_refunded_within_paid',
      sql`${t.paidAmount} is null or ${t.refundedAmount} <= ${t.paidAmount}`,
    ),
    // A paid order has a payment time and an amount; an unpaid one has neither.
    check(
      'orders_paid_shape',
      sql`(${t.status} in ('pending_payment','cancelled') and ${t.paidAt} is null and ${t.paidAmount} is null)
          or (${t.status} not in ('pending_payment','cancelled') and ${t.paidAt} is not null and ${t.paidAmount} is not null)`,
    ),
    check(
      'orders_cancelled_shape',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`,
    ),
    check(
      'orders_fulfillment_matches_status',
      sql`${t.status} not in ('shipped','received','completed') or ${t.fulfillmentStatus} = 'fulfilled'`,
    ),
  ],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

// ---------------------------------------------------------------------------
// order items
// ---------------------------------------------------------------------------

/**
 * Everything about the product and the variant as it was at purchase time.
 * Immutable: a later edit to the product must never change what an order says
 * was bought.
 */
export interface OrderItemSnapshot {
  productName: string;
  productImageUrl: string;
  productKind: 'physical' | 'virtual_card' | 'virtual_coupon' | 'virtual_manual';
  skuCode: string;
  specText: string;
  specValues: Record<string, string>;
  skuImageUrl?: string;
  unitName?: string;
  barCode?: string;
  weight?: string;
  volume?: string;
  /** Activity context, when `orders.kind <> 'normal'`. */
  activity?: { kind: 'groupbuy' | 'presale'; activityId: string; title: string };
  /**
   * What each checkout rule (`PricingContributor`s, then the coupon) took off
   * this line, in the order applied; `amount` negative, e.g. `-10.00`. Written
   * at create — absent on a line written before the field existed. Sums to
   * `-discountAmount` until an operator 改价s the order; the difference is theirs.
   */
  adjustments?: Array<{ source: string; label: string; amount: string }>;
}

export const orderItems = pgTable(
  'order_items',
  {
    id: pk(),
    orderId: fk()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: fk()
      .notNull()
      .references((): AnyPgColumn => products.id, { onDelete: 'restrict' }),
    skuId: fk()
      .notNull()
      .references((): AnyPgColumn => productSkus.id, { onDelete: 'restrict' }),
    /**
     * Stable line key within the order (not `unique`, a reserved word). It is
     * what the storefront sends when refunding or reviewing a single line.
     */
    itemKey: varchar({ length: 32 }).notNull(),
    quantity: integer().notNull(),
    /** Price actually charged per unit, after any activity price. */
    unitPrice: money().notNull(),
    /** Catalogue price per unit at purchase time, for "you saved" display. */
    originalUnitPrice: money(),
    /** Operator cost per unit at purchase time. */
    costUnitPrice: money(),
    /** This line's share of `orders.couponDiscount`. The shares add up to the order total exactly. */
    discountAmount: money().notNull().default('0.00'),
    /** `quantity * unitPrice - discountAmount`. Stored so refunds never re-derive it. */
    totalAmount: money().notNull(),
    refundedQuantity: integer().notNull().default(0),
    refundedAmount: money().notNull().default('0.00'),
    shippedQuantity: integer().notNull().default(0),
    snapshot: jsonb().$type<OrderItemSnapshot>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('order_items_key_uq').on(t.orderId, t.itemKey),
    index('order_items_order_idx').on(t.orderId),
    index('order_items_product_idx').on(t.productId),
    index('order_items_sku_idx').on(t.skuId),
    check('order_items_quantity_positive', sql`${t.quantity} >= 1`),
    check(
      'order_items_prices_non_negative',
      sql`${t.unitPrice} >= 0 and ${t.discountAmount} >= 0 and ${t.totalAmount} >= 0 and ${t.refundedAmount} >= 0 and (${t.originalUnitPrice} is null or ${t.originalUnitPrice} >= 0) and (${t.costUnitPrice} is null or ${t.costUnitPrice} >= 0)`,
    ),
    check(
      'order_items_refunded_within_quantity',
      sql`${t.refundedQuantity} >= 0 and ${t.refundedQuantity} <= ${t.quantity}`,
    ),
    check(
      'order_items_shipped_within_quantity',
      sql`${t.shippedQuantity} >= 0 and ${t.shippedQuantity} <= ${t.quantity}`,
    ),
    check('order_items_refunded_amount_within_total', sql`${t.refundedAmount} <= ${t.totalAmount}`),
  ],
);

export type OrderItem = typeof orderItems.$inferSelect;
export type NewOrderItem = typeof orderItems.$inferInsert;

// ---------------------------------------------------------------------------
// status log
// ---------------------------------------------------------------------------

/**
 * The audit vocabulary. Frozen: adding a value needs an `ALTER TYPE … ADD
 * VALUE` migration, which is the point — the order timeline is a contract with
 * the operator, not a free-text log.
 */
export const orderStatusLogsChangeType = pgEnum('order_status_logs_change_type', [
  'created',
  'paid',
  'pay_failed',
  'cancelled',
  'auto_cancelled',
  'price_adjusted',
  'address_updated',
  'remark_updated',
  'shipped',
  'shipment_cancelled',
  'shipment_updated',
  'virtual_delivered',
  'received',
  'auto_received',
  'reviewed',
  'completed',
  'refund_applied',
  'refund_approved',
  'refund_rejected',
  'refund_cancelled',
  'refund_succeeded',
  'refund_failed',
  'coupon_returned',
  'coupon_granted',
  'invoice_requested',
  'invoice_issued',
  'invoice_rejected',
  'invoice_voided',
  'groupbuy_joined',
  'groupbuy_succeeded',
  'groupbuy_failed',
  'hidden_by_user',
  'deleted_by_admin',
]);

export const orderStatusLogsOperatorKind = pgEnum('order_status_logs_operator_kind', [
  'system',
  'user',
  'admin',
  'gateway',
]);

export const orderStatusLogs = pgTable(
  'order_status_logs',
  {
    id: pk(),
    orderId: fk()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    changeType: orderStatusLogsChangeType().notNull(),
    fromStatus: ordersStatus(),
    toStatus: ordersStatus(),
    message: varchar({ length: 512 }),
    operatorKind: orderStatusLogsOperatorKind().notNull().default('system'),
    operatorAdminId: fk().references((): AnyPgColumn => admins.id, { onDelete: 'set null' }),
    operatorUserId: fk().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('order_status_logs_order_idx').on(t.orderId, t.createdAt),
    index('order_status_logs_type_idx').on(t.changeType, t.createdAt),
  ],
);

export type OrderStatusLog = typeof orderStatusLogs.$inferSelect;
export type NewOrderStatusLog = typeof orderStatusLogs.$inferInsert;

// ---------------------------------------------------------------------------
// shipments
// ---------------------------------------------------------------------------

/** How the goods reach the buyer: a courier, the merchant's own delivery, or virtually. */
export const shipmentsDeliveryMode = pgEnum('shipments_delivery_mode', [
  'express',
  'merchant_delivery',
  'virtual',
]);

export const shipmentsStatus = pgEnum('shipments_status', ['dispatched', 'delivered', 'cancelled']);

/** One dispatch. An order with several shipments was shipped in parts. */
export const shipments = pgTable(
  'shipments',
  {
    id: pk(),
    orderId: fk()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    shipmentNo: varchar({ length: 32 }).notNull(),
    deliveryMode: shipmentsDeliveryMode().notNull(),
    status: shipmentsStatus().notNull().default('dispatched'),
    /** `express` only. */
    expressCompanyId: fk().references(() => expressCompanies.id, { onDelete: 'restrict' }),
    trackingNo: varchar({ length: 64 }),
    /** `merchant_delivery` only: who is driving and how to reach them. */
    courierName: varchar({ length: 64 }),
    courierPhone: varchar({ length: 20 }),
    /** `virtual` only: the card key, coupon note or text handed to the buyer. */
    virtualContent: text(),
    remark: varchar({ length: 255 }),
    operatorAdminId: fk().references((): AnyPgColumn => admins.id, { onDelete: 'set null' }),
    dispatchedAt: instant().notNull().defaultNow(),
    deliveredAt: instant(),
    cancelledAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('shipments_no_uq').on(t.shipmentNo),
    index('shipments_order_idx').on(t.orderId),
    index('shipments_tracking_idx').on(t.trackingNo),
    check(
      'shipments_express_needs_tracking',
      sql`${t.deliveryMode} <> 'express' or (${t.expressCompanyId} is not null and ${t.trackingNo} is not null)`,
    ),
    check(
      'shipments_virtual_needs_content',
      sql`${t.deliveryMode} <> 'virtual' or ${t.virtualContent} is not null`,
    ),
  ],
);

export type Shipment = typeof shipments.$inferSelect;
export type NewShipment = typeof shipments.$inferInsert;

export const shipmentItems = pgTable(
  'shipment_items',
  {
    id: pk(),
    shipmentId: fk()
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    orderItemId: fk()
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    quantity: integer().notNull(),
  },
  (t) => [
    uniqueIndex('shipment_items_uq').on(t.shipmentId, t.orderItemId),
    index('shipment_items_order_item_idx').on(t.orderItemId),
    check('shipment_items_quantity_positive', sql`${t.quantity} >= 1`),
  ],
);

export type ShipmentItem = typeof shipmentItems.$inferSelect;
export type NewShipmentItem = typeof shipmentItems.$inferInsert;

// ---------------------------------------------------------------------------
// invoices
// ---------------------------------------------------------------------------

/**
 * Manual invoicing only: the buyer asks, an operator issues the invoice
 * outside the system and records the number. No e-invoice provider.
 */
export const orderInvoicesStatus = pgEnum('order_invoices_status', [
  'requested',
  'issued',
  'rejected',
  'cancelled',
]);

export const orderInvoicesHeaderType = pgEnum('order_invoices_header_type', [
  'personal',
  'company',
]);

export const orderInvoicesInvoiceType = pgEnum('order_invoices_invoice_type', ['plain', 'special']);

export const orderInvoices = pgTable(
  'order_invoices',
  {
    id: pk(),
    orderId: fk()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: orderInvoicesStatus().notNull().default('requested'),
    headerType: orderInvoicesHeaderType().notNull(),
    invoiceType: orderInvoicesInvoiceType().notNull().default('plain'),
    /** Header details frozen at request time; the buyer's saved profile may change later. */
    name: varchar({ length: 100 }).notNull(),
    dutyNumber: varchar({ length: 50 }),
    drawerPhone: varchar({ length: 20 }),
    email: varchar({ length: 100 }),
    registeredTel: varchar({ length: 30 }),
    registeredAddress: varchar({ length: 255 }),
    bankName: varchar({ length: 100 }),
    bankAccount: varchar({ length: 50 }),
    amount: money().notNull(),
    invoiceNumber: varchar({ length: 50 }),
    remark: varchar({ length: 255 }),
    issuedByAdminId: fk().references((): AnyPgColumn => admins.id, { onDelete: 'set null' }),
    issuedAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One live invoice request per order; a cancelled or rejected one may be re-requested.
    uniqueIndex('order_invoices_open_uq')
      .on(t.orderId)
      .where(sql`status in ('requested','issued')`),
    index('order_invoices_status_idx').on(t.status, t.createdAt),
    index('order_invoices_user_idx').on(t.userId),
    check('order_invoices_amount_non_negative', sql`${t.amount} >= 0`),
    check(
      'order_invoices_issued_shape',
      sql`(${t.status} = 'issued') = (${t.issuedAt} is not null and ${t.invoiceNumber} is not null)`,
    ),
  ],
);

export type OrderInvoice = typeof orderInvoices.$inferSelect;
export type NewOrderInvoice = typeof orderInvoices.$inferInsert;
