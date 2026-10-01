import { sql } from 'drizzle-orm';
import {
  boolean,
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

import { createdAt, deletedAt, emptyJsonArray, fk, instant, money, pk, updatedAt } from './_shared';
import { admins } from './auth';
import { orderItems, orders } from './order';
import { paymentAttempts } from './payment';
import { expressCompanies } from './reference';
import { users } from './user';

/**
 * After-sales: refund requests and their gateway execution.
 *
 * WeChat Pay v3 original-channel refunds only. The order keeps only the
 * roll-up (`orders.refund_status`, `orders.refunded_amount`); everything else
 * about a request is a refund row.
 */

/** What the buyer is asking for. */
export const refundsKind = pgEnum('refunds_kind', ['refund_only', 'return_and_refund']);

/**
 * ```
 * applied ──approve──► approved ──(return_and_refund: goods back)──► processing ──► succeeded
 *    │                    │                                             │
 *    │                    │                                             ├──► failed
 *    ├──reject──► rejected                                              └──► unknown ──query──► succeeded | failed
 *    └──buyer withdraws──► cancelled
 * ```
 *
 * `unknown` means the gateway's answer was lost. It is only ever resolved by
 * querying `outRefundNo`; the number and the amount frozen at creation are
 * never regenerated (REFUND-005 / REFUND-006).
 */
export const refundsStatus = pgEnum('refunds_status', [
  'applied',
  'approved',
  'rejected',
  'processing',
  'succeeded',
  'failed',
  'unknown',
  'cancelled',
]);

/** Where the returned goods currently are. */
export const refundsReturnStage = pgEnum('refunds_return_stage', [
  'not_required',
  'awaiting_shipment',
  'shipped_back',
  'received',
]);

/** Frozen at the first gateway submit. Refusing a retry that disagrees with it is the whole point. */
export interface RefundRequestContext {
  outTradeNo: string;
  transactionId: string;
  provider: string;
  mchId: string;
  appId: string;
  channel: string;
  /** Total of the original payment, as the gateway knows it. */
  totalAmount: string;
  refundAmount: string;
  currency: string;
}

export const refunds = pgTable(
  'refunds',
  {
    id: pk(),
    /** Customer-facing after-sales number. */
    refundNo: varchar({ length: 32 }).notNull(),
    /**
     * The refund number handed to the gateway. Generated with the row and
     * **never** regenerated: a retry reuses it, which is what makes an unknown
     * result queryable instead of re-sendable.
     */
    outRefundNo: varchar({ length: 64 }).notNull(),
    orderId: fk()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The payment this refund goes back through. */
    paymentAttemptId: fk().references(() => paymentAttempts.id, { onDelete: 'restrict' }),
    kind: refundsKind().notNull(),
    status: refundsStatus().notNull().default('applied'),
    returnStage: refundsReturnStage().notNull().default('not_required'),

    /** Total units across `refund_items`. Denormalised for the admin list. */
    quantity: integer().notNull(),
    /**
     * The amount frozen at creation. NOT NULL so a retry carrying a different
     * amount is detectable and refusable (REFUND-005) rather than silently
     * accepted.
     */
    amount: money().notNull(),
    /** Whether `amount` includes the order's freight. */
    includesFreight: boolean().notNull().default(false),
    /** What the gateway actually gave back. Written by the service, never by a controller. */
    refundedAmount: money().notNull().default('0.00'),
    /** Frozen payment context; filled on the first gateway submit and then immutable. */
    requestContext: jsonb().$type<RefundRequestContext>(),
    /** The gateway's own refund id. */
    gatewayRefundId: varchar({ length: 64 }),

    reason: varchar({ length: 255 }),
    explanation: varchar({ length: 512 }),
    images: jsonb().$type<string[]>().notNull().default(emptyJsonArray),
    rejectReason: varchar({ length: 255 }),
    /** The gateway's own words, for staff under 技术详情 (REFUND-019). */
    lastError: varchar({ length: 512 }),
    /** The same failure in Chinese, written with `last_error`; what staff read. */
    lastErrorSummary: varchar({ length: 512 }),
    adminRemark: varchar({ length: 255 }),

    /** Return shipment, for `return_and_refund`. */
    returnExpressCompanyId: fk().references(() => expressCompanies.id, { onDelete: 'set null' }),
    returnTrackingNo: varchar({ length: 64 }),
    returnPhone: varchar({ length: 20 }),
    /**
     * The shop's return address as it was shown to the buyer when the return
     * was approved. Frozen: a later edit of the `refund` config must not change
     * what a buyer was told to do with goods already in the post. Null for
     * `refund_only` and for approvals made before an address was set.
     */
    returnAddress: jsonb().$type<{ name: string; phone: string; address: string }>(),

    /** TRUE when the refund was opened automatically by a failed group buy. */
    isAutomatic: boolean().notNull().default(false),

    reviewedByAdminId: fk().references((): AnyPgColumn => admins.id, { onDelete: 'set null' }),
    reviewedAt: instant(),
    succeededAt: instant(),
    failedAt: instant(),
    cancelledAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('refunds_no_uq').on(t.refundNo),
    uniqueIndex('refunds_out_refund_no_uq').on(t.outRefundNo),
    index('refunds_order_idx').on(t.orderId, t.createdAt),
    index('refunds_user_idx').on(t.userId, t.createdAt),
    index('refunds_status_idx').on(t.status, t.createdAt),
    index('refunds_open_idx')
      .on(t.orderId)
      .where(sql`status in ('applied','approved','processing','unknown')`),
    check('refunds_quantity_positive', sql`${t.quantity} >= 1`),
    // Zero is a refund of an order a coupon paid for in full: it gives back
    // units, the coupon and the seat, and settles without the gateway.
    check('refunds_amount_non_negative', sql`${t.amount} >= 0`),
    check(
      'refunds_refunded_within_amount',
      sql`${t.refundedAmount} >= 0 and ${t.refundedAmount} <= ${t.amount}`,
    ),
    check(
      'refunds_succeeded_shape',
      sql`(${t.status} = 'succeeded') = (${t.succeededAt} is not null)`,
    ),
    check(
      'refunds_rejected_needs_reason',
      sql`${t.status} <> 'rejected' or ${t.rejectReason} is not null`,
    ),
    check(
      'refunds_return_stage_shape',
      sql`(${t.kind} = 'return_and_refund') = (${t.returnStage} <> 'not_required')`,
    ),
  ],
);

export type Refund = typeof refunds.$inferSelect;
export type NewRefund = typeof refunds.$inferInsert;

/**
 * The order lines a refund covers.
 *
 * ## The "one open refund per order item" invariant
 *
 * `isOpen` mirrors the parent refund's status: TRUE while the refund is in
 * `applied | approved | processing | unknown | failed` (a failed refund can
 * still be retried), FALSE once it reaches `succeeded | rejected | cancelled`.
 * The service flips it in the same statement that changes `refunds.status`.
 *
 * `refund_items_open_uq` is a partial unique index on `order_item_id WHERE
 * is_open`, so **an order item can be inside at most one in-flight refund**.
 * Two concurrent applications for the same line: one inserts, the other gets a
 * unique violation and is rejected — no advisory lock, no read-then-write
 * window, and no dependency on the request arriving through a single service.
 *
 * This is deliberately per *item* rather than per *order*: two different lines
 * of one order may legitimately be in after-sales at the same time, which an
 * order-level check would forbid. The cumulative ceiling (`SUM(refunds) <=
 * paid`) is a different invariant and is enforced by
 * `orders.refunded_amount <= orders.paid_amount` under a `FOR UPDATE` lock on
 * the order row, not by this index.
 */
export const refundItems = pgTable(
  'refund_items',
  {
    id: pk(),
    refundId: fk()
      .notNull()
      .references(() => refunds.id, { onDelete: 'cascade' }),
    orderItemId: fk()
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    quantity: integer().notNull(),
    /** This line's share of `refunds.amount`. The shares add up to it exactly. */
    amount: money().notNull(),
    /** Mirrors the parent refund's open-ness. See the table comment. */
    isOpen: boolean().notNull().default(true),
  },
  (t) => [
    uniqueIndex('refund_items_uq').on(t.refundId, t.orderItemId),
    uniqueIndex('refund_items_open_uq')
      .on(t.orderItemId)
      .where(sql`is_open`),
    index('refund_items_order_item_idx').on(t.orderItemId),
    check('refund_items_quantity_positive', sql`${t.quantity} >= 1`),
    check('refund_items_amount_non_negative', sql`${t.amount} >= 0`),
  ],
);

export type RefundItem = typeof refundItems.$inferSelect;
export type NewRefundItem = typeof refundItems.$inferInsert;

/** Append-only trail of what happened to a refund, mirroring `order_status_logs`. */
export const refundLogs = pgTable(
  'refund_logs',
  {
    id: pk(),
    refundId: fk()
      .notNull()
      .references(() => refunds.id, { onDelete: 'cascade' }),
    fromStatus: refundsStatus(),
    toStatus: refundsStatus().notNull(),
    message: text(),
    operatorAdminId: fk().references((): AnyPgColumn => admins.id, { onDelete: 'set null' }),
    operatorUserId: fk().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('refund_logs_refund_idx').on(t.refundId, t.createdAt)],
);

export type RefundLog = typeof refundLogs.$inferSelect;
export type NewRefundLog = typeof refundLogs.$inferInsert;
