import type { DbOrTx, Tx } from '@shop/db';
import { effects, type EffectStatus } from '@shop/db/schema/system';
import { and, asc, desc, eq, inArray, like, lt, lte, notInArray, sql } from 'drizzle-orm';
import { allOf, conditionalUpdate, type ConditionalUpdateResult } from '../kernel/tx';

/** The only file that touches the `effects` table. */

export interface EffectRow {
  id: number;
  scope: string;
  scopeId: string;
  eventType: string;
  payload: unknown;
  status: string;
  attempts: number;
  nextRunAt: Date;
  lastError: string | null;
  lastErrorSummary: string | null;
}

/** A failure as the ledger records it: the raw text, and the Chinese line staff read. */
export interface EffectFailure {
  error: string;
  /** `null` when the failing code did not say; screens show a generic line. */
  summary: string | null;
}

export async function insertIgnore(
  tx: DbOrTx,
  input: {
    scope: string;
    scopeId: string;
    eventType: string;
    payload: unknown;
    now: Date;
    runAt?: Date;
  },
): Promise<boolean> {
  const rows = await tx
    .insert(effects)
    .values({
      scope: input.scope,
      scopeId: input.scopeId,
      eventType: input.eventType,
      payload: (input.payload ?? {}) as never,
      status: 'pending',
      attempts: 0,
      nextRunAt: input.runAt ?? input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing({
      target: [effects.scope, effects.scopeId, effects.eventType],
    })
    .returning({ id: effects.id });
  return rows.length > 0;
}

/**
 * Claims up to `limit` due rows with `FOR UPDATE SKIP LOCKED` and immediately
 * pushes their `next_run_at` out by the lease, so a second dispatcher neither
 * blocks on them nor picks them up again while the first is still working.
 */
export async function claimDue(
  tx: Tx,
  options: { limit: number; now: Date; leaseMs: number },
): Promise<EffectRow[]> {
  const claimed = await tx
    .select()
    .from(effects)
    .where(and(eq(effects.status, 'pending'), lte(effects.nextRunAt, options.now)))
    .orderBy(asc(effects.nextRunAt), asc(effects.id))
    .limit(options.limit)
    .for('update', { skipLocked: true });

  if (claimed.length === 0) return [];
  const ids = claimed.map((row) => row.id);
  await tx
    .update(effects)
    .set({
      attempts: sql`${effects.attempts} + 1`,
      nextRunAt: new Date(options.now.getTime() + options.leaseMs),
      dispatchedAt: options.now,
      updatedAt: options.now,
    })
    .where(inArray(effects.id, ids));

  return claimed.map((row) => ({
    id: row.id,
    scope: row.scope,
    scopeId: row.scopeId,
    eventType: row.eventType,
    payload: row.payload,
    status: row.status,
    // The caller sees the attempt number it is about to make.
    attempts: row.attempts + 1,
    nextRunAt: row.nextRunAt,
    lastError: row.lastError,
    lastErrorSummary: row.lastErrorSummary,
  }));
}

/**
 * `next_run_at` of the oldest row that is due and waiting: pending, due by
 * `now`, and not under a dispatcher's lease (a claim pushes `next_run_at` past
 * the lease, so claimed rows are not "due"). `null` when nothing is waiting.
 * One read of `effects_due_idx`.
 */
export async function oldestDue(db: DbOrTx, now: Date): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | string | null>`min(${effects.nextRunAt})` })
    .from(effects)
    .where(and(eq(effects.status, 'pending'), lte(effects.nextRunAt, now)));
  const at = row?.at ?? null;
  return at === null ? null : new Date(at);
}

export async function markDone(tx: DbOrTx, id: number, now: Date): Promise<void> {
  await tx
    .update(effects)
    .set({
      status: 'done' satisfies EffectStatus,
      lastError: null,
      lastErrorSummary: null,
      updatedAt: now,
    })
    .where(eq(effects.id, id));
}

/** Writes the handler's report on its row. Touches nothing the dispatcher owns. */
export async function setOutcome(tx: DbOrTx, id: number, outcome: unknown): Promise<void> {
  await tx
    .update(effects)
    .set({ outcome: (outcome ?? null) as never })
    .where(eq(effects.id, id));
}

export async function scheduleRetry(
  tx: DbOrTx,
  id: number,
  input: EffectFailure & { runAt: Date; now: Date },
): Promise<void> {
  await tx
    .update(effects)
    .set({
      status: 'pending' satisfies EffectStatus,
      nextRunAt: input.runAt,
      lastError: input.error,
      lastErrorSummary: input.summary,
      updatedAt: input.now,
    })
    .where(eq(effects.id, id));
}

export async function markUnknown(
  tx: DbOrTx,
  id: number,
  input: EffectFailure & { now: Date },
): Promise<void> {
  await tx
    .update(effects)
    .set({
      status: 'unknown' satisfies EffectStatus,
      lastError: input.error,
      lastErrorSummary: input.summary,
      updatedAt: input.now,
    })
    .where(eq(effects.id, id));
}

export async function findOne(
  db: DbOrTx,
  key: { scope: string; scopeId: string; eventType: string },
): Promise<EffectRow | null> {
  const rows = await db
    .select()
    .from(effects)
    .where(
      and(
        eq(effects.scope, key.scope),
        eq(effects.scopeId, key.scopeId),
        eq(effects.eventType, key.eventType),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? (row as EffectRow) : null;
}

/** For the admin "stuck effects" screen. */
export async function listByStatus(
  db: DbOrTx,
  status: EffectStatus,
  limit = 100,
): Promise<EffectRow[]> {
  const rows = await db
    .select()
    .from(effects)
    .where(eq(effects.status, status))
    .orderBy(asc(effects.id))
    .limit(limit);
  return rows as EffectRow[];
}

/**
 * Deletes up to `limit` `done` rows that finished before `before`, except in
 * `keepScopes`. Parked (`unknown`) and `pending` rows are never touched.
 *
 * "Finished" is `next_run_at`: a claim pushes it to claim time + lease, and a
 * done row is never claimed again, so it is the last attempt give or take a
 * minute — and `(status, next_run_at)` is `effects_due_idx`, so the scan is an
 * index range rather than the whole table.
 */
export async function pruneDone(
  db: DbOrTx,
  input: { before: Date; limit: number; keepScopes: readonly string[] },
): Promise<number> {
  const victims = db
    .select({ id: effects.id })
    .from(effects)
    .where(
      allOf(
        eq(effects.status, 'done' satisfies EffectStatus),
        lt(effects.nextRunAt, input.before),
        input.keepScopes.length > 0 ? notInArray(effects.scope, [...input.keepScopes]) : undefined,
      ),
    )
    .orderBy(asc(effects.id))
    .limit(input.limit);
  const result = await db.delete(effects).where(inArray(effects.id, victims));
  return (result as { rowCount?: number | null }).rowCount ?? 0;
}

/** Parked rows in these scopes: the 「异常待处理」 figure on the admin home. */
export async function countParked(db: DbOrTx, scopes: readonly string[]): Promise<number> {
  if (scopes.length === 0) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(effects)
    .where(
      and(
        eq(effects.status, 'unknown' satisfies EffectStatus),
        inArray(effects.scope, [...scopes]),
      ),
    );
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// The operator console
// ---------------------------------------------------------------------------

/**
 * A row as the "待处理任务" console shows it: no payload — a payload can carry a
 * `prepay_id` or an address and the list is a screen, not a debugger — but with
 * both timestamps, because "parked three days ago" is the whole triage signal.
 */
export interface EffectConsoleRow {
  id: number;
  scope: string;
  scopeId: string;
  eventType: string;
  status: string;
  attempts: number;
  /** Raw; staff see it only under 技术详情. */
  lastError: string | null;
  /** Chinese, for staff; `null` when the failing code did not say. */
  lastErrorSummary: string | null;
  nextRunAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface EffectListFilter {
  status: string;
  /** One scope to show. */
  scope?: string;
  /**
   * The scopes this caller may see at all. A console that ships with one domain
   * passes its own list so it cannot quietly become everybody's console; omit it
   * for a platform-wide screen.
   */
  scopes?: readonly string[];
  eventType?: string;
  /**
   * Narrows to the rows whose `scope_id` starts with this text, matched
   * literally (`%` and `_` in it are not wildcards). A domain that encodes a
   * sub-kind in its scope ids — notifications use `<code>:<subject>` — filters
   * on `<code>:` with it.
   */
  scopeIdPrefix?: string;
  /** 1-based. */
  page: number;
  pageSize: number;
}

/**
 * A console row plus its payload and the handler's last outcome. Only for a
 * console whose own screen is built from them (the notification log reads the
 * recipient and the channels that went out); neither is sent to the browser
 * as is.
 */
export type EffectDetailRow = EffectConsoleRow & { payload: unknown; outcome: unknown };

const consoleColumns = {
  id: effects.id,
  scope: effects.scope,
  scopeId: effects.scopeId,
  eventType: effects.eventType,
  status: effects.status,
  attempts: effects.attempts,
  lastError: effects.lastError,
  lastErrorSummary: effects.lastErrorSummary,
  nextRunAt: effects.nextRunAt,
  createdAt: effects.createdAt,
  updatedAt: effects.updatedAt,
} as const;

const detailColumns = {
  ...consoleColumns,
  payload: effects.payload,
  outcome: effects.outcome,
} as const;

function scopeFilter(filter: EffectListFilter) {
  if (filter.scope !== undefined) {
    // A caller with an allow-list may only narrow inside it.
    if (filter.scopes && !filter.scopes.includes(filter.scope)) return sql`false`;
    return eq(effects.scope, filter.scope);
  }
  return filter.scopes ? inArray(effects.scope, [...filter.scopes]) : undefined;
}

/** `LIKE` treats `%`, `_` and backslash specially; a prefix is matched as text. */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The filtered, paginated read the console needs.
 *
 * Ordered by `updated_at desc`, so whatever just failed is at the top, with the
 * id as a tiebreaker because a batch settles inside the same millisecond.
 *
 * Rows come without their payload unless the caller asks for it with
 * `withPayload: true`.
 */
export async function listEffects(
  db: DbOrTx,
  filter: EffectListFilter & { withPayload: true },
): Promise<{ rows: EffectDetailRow[]; total: number }>;
export async function listEffects(
  db: DbOrTx,
  filter: EffectListFilter & { withPayload?: false },
): Promise<{ rows: EffectConsoleRow[]; total: number }>;
export async function listEffects(
  db: DbOrTx,
  filter: EffectListFilter & { withPayload?: boolean },
): Promise<{ rows: EffectConsoleRow[] | EffectDetailRow[]; total: number }> {
  const where = allOf(
    scopeFilter(filter),
    eq(effects.status, filter.status),
    filter.eventType === undefined ? undefined : eq(effects.eventType, filter.eventType),
    filter.scopeIdPrefix === undefined
      ? undefined
      : like(effects.scopeId, likePrefix(filter.scopeIdPrefix)),
  );

  const rows = await db
    .select(filter.withPayload ? detailColumns : consoleColumns)
    .from(effects)
    .where(where)
    .orderBy(desc(effects.updatedAt), asc(effects.id))
    .offset((filter.page - 1) * filter.pageSize)
    .limit(filter.pageSize);

  const [count] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(effects)
    .where(where);

  return { rows: rows as EffectDetailRow[], total: count?.total ?? 0 };
}

export async function findById(
  db: DbOrTx,
  id: number,
  scopes?: readonly string[],
): Promise<EffectDetailRow | null> {
  const rows = await db
    .select(detailColumns)
    .from(effects)
    .where(allOf(eq(effects.id, id), scopes ? inArray(effects.scope, [...scopes]) : undefined))
    .limit(1);
  return (rows[0] as EffectDetailRow | undefined) ?? null;
}

/**
 * The statuses an operator may hand back to the dispatcher.
 *
 * `EFFECT_STATUSES` is `pending | done | unknown` and has no `failed` — a
 * handler that fails is either retried (`pending`, still the dispatcher's) or
 * parked (`unknown`). So the list is `unknown` alone: a `pending` row needs no
 * rescuing and re-queueing it would fight the dispatcher holding its lease, and
 * `done` is done. The constant exists so that if a `failed` status is ever
 * added it joins here and nothing else changes.
 */
export const RETRYABLE_EFFECT_STATUSES = ['unknown'] as const satisfies readonly EffectStatus[];

/**
 * Hands a parked row back to the dispatcher.
 *
 * `unknown → pending`, `next_run_at = now`, attempts back to zero so the row
 * gets the full backoff ladder again instead of being parked on its next
 * failure. The handler is deliberately *not* run here: it is parked because it
 * kept failing, it usually talks to a third party, and an admin HTTP request is
 * the wrong place to wait for that.
 *
 * The guard is the whole point. Two operators clicking 重试 on the same row both
 * run this statement, PostgreSQL serialises them, and only one sees
 * `affected > 0` — so the effect runs once. Decide on `won`, never on a prior
 * read.
 *
 * `scopes`, when given, is part of the guard: a console that may only see its
 * own scopes cannot re-queue anybody else's row, even with an id it guessed.
 */
export async function retryEffect(
  db: DbOrTx,
  id: number,
  now: Date,
  scopes?: readonly string[],
): Promise<ConditionalUpdateResult> {
  return conditionalUpdate(db, effects, {
    where: allOf(
      eq(effects.id, id),
      inArray(effects.status, [...RETRYABLE_EFFECT_STATUSES]),
      scopes ? inArray(effects.scope, [...scopes]) : undefined,
    ),
    set: { status: 'pending' satisfies EffectStatus, attempts: 0, nextRunAt: now, updatedAt: now },
  });
}
