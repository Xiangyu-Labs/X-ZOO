import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { createdAt, fk, instant, pk, updatedAt } from './_shared';

/**
 * Cross-cutting platform tables: typed configuration, the post-commit
 * side-effect ledger, and the dead-letter box for jobs.
 */

/**
 * Typed configuration (see `core/src/kernel/config-registry.ts`). Values are
 * stored per `(group, key)` as JSON so a boolean stays a boolean; the shape is
 * validated against the zod schema of `defineConfigGroup({ group, ... })` on
 * write, and reads go through `config.get('<group>')`, never by key.
 */
export const configValues = pgTable(
  'config_values',
  {
    /** Config group name, matching the owning domain (`payment`, `storage`, …). */
    group: varchar({ length: 64 }).notNull(),
    key: varchar({ length: 64 }).notNull(),
    value: jsonb().notNull(),
    updatedAt: updatedAt(),
    /** Who last wrote it; null for seeds and jobs. */
    updatedBy: fk(),
  },
  (t) => [primaryKey({ columns: [t.group, t.key] })],
);

/** `pending` → `done`, or `pending` → `pending` (retry) → `unknown` after max attempts. */
export const EFFECT_STATUSES = ['pending', 'done', 'unknown'] as const;
export type EffectStatus = (typeof EFFECT_STATUSES)[number];

/**
 * The side-effect ledger.
 *
 * `docs/conventions.md`: "anything that calls a third party happens *after*
 * commit, via the effects ledger — never inside the transaction". A domain
 * writes a row inside its transaction with `recordEffect(tx, …)` (INSERT … ON
 * CONFLICT DO NOTHING, so recording twice is free), and the dispatcher claims
 * rows with `FOR UPDATE SKIP LOCKED` after the commit and runs the registered
 * handler.
 *
 * `UNIQUE (scope, scope_id, event_type)` is the whole exactly-once story: the
 * same event for the same aggregate can only ever be enqueued once, and the
 * handler itself still has to be idempotent because delivery is at-least-once.
 *
 * This is the only ledger: orders use `scope = 'order'`, `scope_id = String(orderId)`.
 */
export const effects = pgTable(
  'effects',
  {
    id: pk(),
    /** Aggregate kind: `order`, `refund`, `user`, … Usually the domain name. */
    scope: varchar({ length: 32 }).notNull(),
    /** Aggregate id, as text so non-numeric keys (an out_trade_no) also fit. */
    scopeId: varchar({ length: 64 }).notNull(),
    /** `order.paid`, `refund.approved`, … Namespaced by scope by convention. */
    eventType: varchar({ length: 64 }).notNull(),
    payload: jsonb().notNull(),
    status: varchar({ length: 16 }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    /** When the dispatcher may next pick this row up. Backoff moves it forward. */
    nextRunAt: instant().notNull().defaultNow(),
    /**
     * Truncated message of the last failure; never a stack trace, never a secret.
     * Raw (a gateway's errmsg, a channel id): staff see it only under 技术详情.
     */
    lastError: text(),
    /**
     * What the handler reported about its last attempt, for a console to show
     * (the notification log reads which channels went out). Owned by the
     * handler's domain; the dispatcher never reads or writes it. `null` until a
     * handler records one.
     */
    outcome: jsonb(),
    /**
     * The same failure in Chinese for staff, written with `last_error` by the
     * code that knows what the error means. `null` when it did not say; the
     * screens then show a generic line.
     */
    lastErrorSummary: text(),
    dispatchedAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('effects_scope_event_key').on(t.scope, t.scopeId, t.eventType),
    /** The claim query: `WHERE status = 'pending' AND next_run_at <= now()`. */
    index('effects_due_idx').on(t.status, t.nextRunAt),
    index('effects_scope_idx').on(t.scope, t.scopeId),
  ],
);

/**
 * Dead letter box. A BullMQ job that exhausts its attempts lands here so an
 * operator sees it in the admin UI instead of only in a Redis key that expires.
 */
export const failedJobs = pgTable(
  'failed_jobs',
  {
    id: pk(),
    queue: varchar({ length: 64 }).notNull(),
    jobName: varchar({ length: 64 }).notNull(),
    jobId: varchar({ length: 128 }),
    payload: jsonb().notNull(),
    /** Raw (an exception's message): staff see it only under 技术详情. */
    error: text().notNull(),
    /**
     * The same failure in Chinese for staff, written with `error` by the worker.
     * `null` on rows from before it was written; the screen then shows a generic line.
     */
    errorSummary: text(),
    attempts: integer().notNull().default(0),
    resolvedAt: instant(),
    createdAt: createdAt(),
  },
  (t) => [index('failed_jobs_queue_idx').on(t.queue, t.createdAt)],
);
