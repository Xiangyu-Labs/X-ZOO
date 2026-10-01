import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { createdAt, emptyJsonObject, fk, instant, money, pk, updatedAt } from './_shared';
import { admins } from './auth';
import { orders } from './order';
import { users } from './user';

/**
 * The payment reliability layer: attempts, callbacks, exceptions and the
 * capital-flow ledger.
 *
 * WeChat Pay v3 is the only gateway.
 */

// ---------------------------------------------------------------------------
// payment attempts
// ---------------------------------------------------------------------------

export const paymentAttemptsProvider = pgEnum('payment_attempts_provider', ['wechat_v3']);

/** Which WeChat trade type the attempt was created with. */
export const paymentAttemptsChannel = pgEnum('payment_attempts_channel', [
  'wechat_mini',
  'wechat_oa',
  'wechat_h5',
]);

/**
 * ```
 * creating ──gateway accepted──► submitted ──notify/query paid──► paid
 *    │                              │
 *    │                              ├──cancel requested──► closing ──confirmed──► closed
 *    │                              └──gateway result lost──► unknown ──query──► paid | closed
 *    └──gateway refused──► failed
 * ```
 *
 * `unknown` is never resolved by guessing: it is queried by the frozen
 * `outTradeNo` and nothing else. Only `closed` — set after the gateway has
 * confirmed the close and `closedConfirmedAt` is stamped — releases stock and
 * the coupon (QUEUE-003 / QUEUE-004).
 */
export const paymentAttemptsStatus = pgEnum('payment_attempts_status', [
  'creating',
  'submitted',
  'paid',
  'closing',
  'closed',
  'failed',
  'unknown',
]);

/** Frozen adapter context. Never contains a key, certificate or API secret. */
export interface PaymentContext {
  tradeType: string;
  openid?: string;
  clientIp?: string;
  notifyUrl?: string;
  description?: string;
  /** Anything the driver needs to replay the request verbatim. */
  extra?: Record<string, unknown>;
}

/**
 * One attempt to collect money for an order.
 *
 * **Immutable once written** (PAYC-004): `outTradeNo`, `provider`, `channel`,
 * `mchId`, `appId`, `amount`, `payerUserId` and `context` are frozen at
 * creation. A repeated "pay" tap that matches them exactly replays the same
 * row; anything different is refused rather than silently updated. Only the
 * state columns below the divider ever change.
 */
export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: pk(),
    orderId: fk()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    /** The merchant order number handed to the gateway. Globally unique, reused on every retry. */
    outTradeNo: varchar({ length: 64 }).notNull(),
    provider: paymentAttemptsProvider().notNull().default('wechat_v3'),
    channel: paymentAttemptsChannel().notNull(),
    mchId: varchar({ length: 64 }).notNull(),
    appId: varchar({ length: 64 }).notNull(),
    amount: money().notNull(),
    currency: varchar({ length: 3 }).notNull().default('CNY'),
    payerUserId: fk().references(() => users.id, { onDelete: 'restrict' }),
    context: jsonb().$type<PaymentContext>().notNull().default(emptyJsonObject),
    // --- mutable state -----------------------------------------------------
    status: paymentAttemptsStatus().notNull().default('creating'),
    /** The gateway's own transaction id. Set once, never overwritten. */
    transactionId: varchar({ length: 64 }),
    /** Prepay handle returned by the gateway; the client needs it to invoke the SDK. */
    prepayId: varchar({ length: 128 }),
    /** Conclusion of the last query or close call, for the operator console. */
    lastResult: varchar({ length: 512 }),
    paidAt: instant(),
    /** Stamped only when the gateway has *confirmed* the close. `closed` without it is a defect. */
    closedConfirmedAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payment_attempts_out_trade_no_uq').on(t.outTradeNo),
    index('payment_attempts_order_idx').on(t.orderId, t.createdAt),
    index('payment_attempts_status_idx').on(t.status),
    uniqueIndex('payment_attempts_transaction_uq')
      .on(t.mchId, t.transactionId)
      .where(sql`transaction_id is not null`),
    // At most one live attempt per order: a second pay tap replays the open row.
    uniqueIndex('payment_attempts_open_uq')
      .on(t.orderId)
      .where(sql`status in ('creating','submitted','closing','unknown')`),
    check('payment_attempts_amount_positive', sql`${t.amount} > 0`),
    check(
      'payment_attempts_paid_shape',
      sql`(${t.status} = 'paid') = (${t.paidAt} is not null and ${t.transactionId} is not null)`,
    ),
    check(
      'payment_attempts_closed_shape',
      sql`${t.status} <> 'closed' or ${t.closedConfirmedAt} is not null`,
    ),
  ],
);

export type PaymentAttempt = typeof paymentAttempts.$inferSelect;
export type NewPaymentAttempt = typeof paymentAttempts.$inferInsert;

// ---------------------------------------------------------------------------
// raw callbacks
// ---------------------------------------------------------------------------

export const paymentCallbacksKind = pgEnum('payment_callbacks_kind', [
  'transaction_success',
  'refund_success',
  'refund_abnormal',
  'refund_closed',
  'unknown',
]);

/**
 * Every gateway notification, verified or not, exactly once.
 *
 * `UNIQUE (mch_id, provider_notify_id)` makes a replayed notification a no-op
 * at the database level, which is what lets the handler be written as "insert,
 * on conflict do nothing, and only act when a row was inserted" (PAY-007).
 */
export const paymentCallbacks = pgTable(
  'payment_callbacks',
  {
    id: pk(),
    provider: paymentAttemptsProvider().notNull().default('wechat_v3'),
    kind: paymentCallbacksKind().notNull(),
    mchId: varchar({ length: 64 }).notNull(),
    /** The gateway's notification id (`id` in a WeChat v3 envelope). */
    providerNotifyId: varchar({ length: 64 }).notNull(),
    outTradeNo: varchar({ length: 64 }),
    transactionId: varchar({ length: 64 }),
    signatureVerified: boolean().notNull(),
    /** Decrypted resource object. Secrets are never stored. */
    payload: jsonb().$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
    processedAt: instant(),
    /** What the handler concluded, e.g. `paid`, `ignored: already paid`, `exception recorded`. */
    result: varchar({ length: 255 }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('payment_callbacks_notify_uq').on(t.mchId, t.providerNotifyId),
    index('payment_callbacks_out_trade_no_idx').on(t.outTradeNo),
    index('payment_callbacks_created_at_idx').on(t.createdAt),
  ],
);

export type PaymentCallback = typeof paymentCallbacks.$inferSelect;
export type NewPaymentCallback = typeof paymentCallbacks.$inferInsert;

// ---------------------------------------------------------------------------
// payment exceptions
// ---------------------------------------------------------------------------

/** Why the money could not simply be booked against an order. */
export const paymentExceptionsReason = pgEnum('payment_exceptions_reason', [
  /** A second real payment landed on an order that was already paid. */
  'duplicate_payment',
  /** Money arrived for an order that had already been cancelled. */
  'cancelled_order_payment',
  /** The merchant order number matches no attempt at all. */
  'unmatched_payment',
  /** The amount does not match what the attempt asked for. */
  'amount_mismatch',
]);

export const paymentExceptionsStatus = pgEnum('payment_exceptions_status', [
  'open',
  'refunding',
  'refunded',
  'refund_unknown',
  'refund_failed',
  'ignored',
]);

/**
 * Money the shop received but cannot book.
 *
 * `orderId` and `paymentAttemptId` are both nullable: a notification carrying
 * an unknown merchant order number can still be recorded, which is the whole
 * point — the money exists whether or not we can attribute it.
 *
 * `UNIQUE (mch_id, transaction_id)` means a replayed abnormal notification
 * records one exception, not a queue of them.
 */
export const paymentExceptions = pgTable(
  'payment_exceptions',
  {
    id: pk(),
    orderId: fk().references(() => orders.id, { onDelete: 'set null' }),
    paymentAttemptId: fk().references(() => paymentAttempts.id, { onDelete: 'set null' }),
    mchId: varchar({ length: 64 }).notNull(),
    transactionId: varchar({ length: 64 }).notNull(),
    outTradeNo: varchar({ length: 64 }),
    reason: paymentExceptionsReason().notNull(),
    paidAmount: money().notNull(),
    currency: varchar({ length: 3 }).notNull().default('CNY'),
    context: jsonb().$type<PaymentContext>().notNull().default(emptyJsonObject),
    status: paymentExceptionsStatus().notNull().default('open'),
    /** Stable refund number for this exception. Generated once, reused on every retry. */
    refundNo: varchar({ length: 64 }),
    /** Frozen refund request plus the gateway's answers. */
    refundRequest: jsonb().$type<Record<string, unknown>>(),
    operatorAdminId: fk().references((): AnyPgColumn => admins.id, { onDelete: 'set null' }),
    note: text(),
    refundedAt: instant(),
    resolvedAt: instant(),
    /** When the operator was last alerted about this row. */
    alarmedAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payment_exceptions_transaction_uq').on(t.mchId, t.transactionId),
    uniqueIndex('payment_exceptions_refund_no_uq').on(t.refundNo),
    index('payment_exceptions_order_idx').on(t.orderId),
    index('payment_exceptions_status_idx').on(t.status, t.createdAt),
    check('payment_exceptions_amount_positive', sql`${t.paidAmount} > 0`),
    check(
      'payment_exceptions_resolved_shape',
      sql`${t.status} not in ('refunded','ignored') or ${t.resolvedAt} is not null`,
    ),
  ],
);

export type PaymentException = typeof paymentExceptions.$inferSelect;
export type NewPaymentException = typeof paymentExceptions.$inferInsert;

// ---------------------------------------------------------------------------
// capital flows
// ---------------------------------------------------------------------------

export const capitalFlowsKind = pgEnum('capital_flows_kind', [
  'order_payment',
  'order_refund',
  'exception_refund',
]);

export const capitalFlowsDirection = pgEnum('capital_flows_direction', ['in', 'out']);

/**
 * The money ledger: one row per real movement through the gateway.
 *
 * `UNIQUE (kind, reference)` is what makes "written exactly once per payment or
 * refund" true (PAY-007). `reference` is the gateway-facing number that already
 * identifies the movement — `payment_attempts.out_trade_no` for a payment,
 * `refunds.out_refund_no` or `payment_exceptions.refund_no` for a refund — so
 * the ledger writer needs no extra idempotency key of its own.
 */
export const capitalFlows = pgTable(
  'capital_flows',
  {
    id: pk(),
    kind: capitalFlowsKind().notNull(),
    reference: varchar({ length: 64 }).notNull(),
    direction: capitalFlowsDirection().notNull(),
    amount: money().notNull(),
    currency: varchar({ length: 3 }).notNull().default('CNY'),
    orderId: fk().references(() => orders.id, { onDelete: 'set null' }),
    userId: fk().references(() => users.id, { onDelete: 'set null' }),
    provider: paymentAttemptsProvider().notNull().default('wechat_v3'),
    mchId: varchar({ length: 64 }),
    transactionId: varchar({ length: 64 }),
    /** Human-readable line for the operator report. */
    note: varchar({ length: 255 }),
    occurredAt: instant().notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('capital_flows_reference_uq').on(t.kind, t.reference),
    index('capital_flows_order_idx').on(t.orderId),
    index('capital_flows_occurred_at_idx').on(t.occurredAt),
    check('capital_flows_amount_positive', sql`${t.amount} > 0`),
  ],
);

export type CapitalFlow = typeof capitalFlows.$inferSelect;
export type NewCapitalFlow = typeof capitalFlows.$inferInsert;

// ---------------------------------------------------------------------------
// 小程序发货信息管理 (WeChat's view of a mini-program payment)
// ---------------------------------------------------------------------------

/** How WeChat says the buyer confirmed receipt: 1 手动, 2 自动, or our own verified component callback. */
export const wechatTradeOrdersConfirmSource = pgEnum('wechat_trade_orders_confirm_source', [
  'manual',
  'auto',
  'component',
]);

/**
 * One row per order paid through the mini program once its shipping has been
 * reported to WeChat — what 小程序发货信息管理 knows about the payment.
 *
 * WeChat freezes a managed mini program's money until it has been told the
 * goods left (`upload_shipping_info`) and the buyer confirmed receipt. The row
 * is written by the effect that makes the upload, and by the
 * `trade_manage_order_settlement` push. It is WeChat's side of the story only:
 * the order's own `shipped -> received` stays on `orders` and moves through the
 * state machine, never through this table.
 *
 * `outTradeNo` / `transactionId` are copied from the paid `payment_attempts`
 * row, because the push names the payment and not our order.
 */
export const wechatTradeOrders = pgTable(
  'wechat_trade_orders',
  {
    id: pk(),
    orderId: fk()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    paymentAttemptId: fk()
      .notNull()
      .references(() => paymentAttempts.id, { onDelete: 'restrict' }),
    mchId: varchar({ length: 64 }).notNull(),
    outTradeNo: varchar({ length: 64 }).notNull(),
    transactionId: varchar({ length: 64 }).notNull(),
    /** The first upload WeChat accepted. */
    uploadedAt: instant(),
    /** The upload that told WeChat everything is out: the unified one, or the last split one. */
    allDeliveredAt: instant(),
    /** WeChat lets a payment's shipping be corrected once; this is when that was spent. */
    correctedAt: instant(),
    /** When WeChat (or its 确认收货 component, verified with `get_order`) says the buyer confirmed. */
    confirmedAt: instant(),
    confirmSource: wechatTradeOrdersConfirmSource(),
    /** When WeChat released the money to the merchant. */
    settledAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('wechat_trade_orders_order_uq').on(t.orderId),
    uniqueIndex('wechat_trade_orders_out_trade_no_uq').on(t.outTradeNo),
    index('wechat_trade_orders_transaction_idx').on(t.transactionId),
    check(
      'wechat_trade_orders_confirm_shape',
      sql`(${t.confirmedAt} is null) = (${t.confirmSource} is null)`,
    ),
  ],
);

export type WechatTradeOrder = typeof wechatTradeOrders.$inferSelect;
export type NewWechatTradeOrder = typeof wechatTradeOrders.$inferInsert;
