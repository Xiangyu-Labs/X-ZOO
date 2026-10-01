import type { Db, DbOrTx, Tx } from '@shop/db';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

/**
 * Transactions, row locks and conditional updates — the three moves every
 * state change in this system is built from.
 *
 * `docs/conventions.md`, verbatim:
 *  - "Transactions: `withTx(async (tx) => …)`. Anything that calls a third
 *    party happens *after* commit, via the effects ledger."
 *  - "State changes are conditional updates. `UPDATE … WHERE id = $1 AND
 *    status = 'expected'` and decide on the affected row count. Read-then-write
 *    on status, stock, seats or counters is a defect."
 *  - "Use `lockRow` (`SELECT … FOR UPDATE`) when several rows must agree."
 */

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface TxOptions {
  isolationLevel?: IsolationLevel;
  readOnly?: boolean;
}

/**
 * Runs `fn` in one transaction. Nested calls reuse the outer transaction
 * instead of opening a savepoint, so a service that is already inside a
 * transaction can call another service without surprising anybody.
 */
export async function withTx<T>(
  db: DbOrTx,
  fn: (tx: Tx) => Promise<T>,
  options: TxOptions = {},
): Promise<T> {
  if (isTx(db)) return fn(db);
  const config: TxOptions = {};
  if (options.isolationLevel) config.isolationLevel = options.isolationLevel;
  if (options.readOnly !== undefined) config.readOnly = options.readOnly;
  return (db as Db).transaction((tx) => fn(tx), config);
}

/**
 * Distinguishes an open transaction from a pool handle.
 *
 * NOT by looking for `transaction`: a drizzle `PgTransaction` has that method
 * too (it opens a savepoint), so checking for it silently turns every nested
 * `withTx` into a savepoint — which is exactly the bug an integration test
 * caught here. `rollback()` exists only on `PgTransaction`.
 */
function isTx(value: DbOrTx): value is Tx {
  return typeof (value as { rollback?: unknown }).rollback === 'function';
}

/** Any table this kernel can lock: it must have a numeric `id` primary key. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TableWithId = PgTable & { id: any };

export interface LockOptions {
  /**
   * `skipLocked` returns nothing instead of waiting — the right choice for a
   * work queue (see the effects dispatcher), the wrong choice when the row must
   * be read.
   */
  skipLocked?: boolean;
  /** `noWait` fails loudly instead of waiting. */
  noWait?: boolean;
}

/**
 * `SELECT … WHERE id = $1 FOR UPDATE`, returning the locked row or `null`.
 *
 * Use it when a decision spans several rows (order + its items + stock) and they
 * must agree. For a single-row state change prefer `conditionalUpdate`: it is
 * one statement and cannot race with itself.
 */
export async function lockRow<T extends TableWithId>(
  tx: Tx,
  table: T,
  id: number,
  options: LockOptions = {},
): Promise<Record<string, unknown> | null> {
  const rows = await forClause(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tx.select() as any).from(table).where(eq(table.id, id)).limit(1),
    options,
  );
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
}

/** `lockRow` for several ids at once, locked in ascending id order to avoid deadlocks. */
export async function lockRows<T extends TableWithId>(
  tx: Tx,
  table: T,
  ids: readonly number[],
  options: LockOptions = {},
): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  const ordered = [...new Set(ids)].sort((a, b) => a - b);
  const rows = await forClause(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tx.select() as any)
      .from(table)
      .where(sql`${table.id} in ${ordered}`)
      .orderBy(table.id),
    options,
  );
  return rows as Record<string, unknown>[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function forClause(query: any, options: LockOptions): Promise<unknown[]> {
  if (options.skipLocked) return query.for('update', { skipLocked: true });
  if (options.noWait) return query.for('update', { noWait: true });
  return query.for('update');
}

export interface ConditionalUpdateResult {
  /** 0 means somebody else got there first. Branch on this, never on a prior read. */
  affected: number;
  /** `affected > 0`, for readability at the call site. */
  won: boolean;
}

/**
 * One `UPDATE … WHERE <guard>` and the number of rows it changed.
 *
 * The guard must contain the state you are transitioning *from*. Two concurrent
 * callers both run the statement; PostgreSQL serialises them on the row and the
 * loser sees `affected === 0`.
 *
 * @example
 * const { won } = await conditionalUpdate(tx, orders, {
 *   where: and(eq(orders.id, id), eq(orders.status, 'pending_payment')),
 *   set: { status: 'paid', paidAt: ctx.clock.now() },
 * });
 * if (!won) throw new DomainError('ORDER_NOT_PAYABLE');
 */
export async function conditionalUpdate<T extends PgTable>(
  tx: DbOrTx,
  table: T,
  args: { where: SQL | undefined; set: Record<string, unknown> },
): Promise<ConditionalUpdateResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await (tx as any).update(table).set(args.set).where(args.where);
  const affected = readRowCount(result);
  return { affected, won: affected > 0 };
}

/** Same, for `DELETE … WHERE <guard>`. */
export async function conditionalDelete<T extends PgTable>(
  tx: DbOrTx,
  table: T,
  where: SQL | undefined,
): Promise<ConditionalUpdateResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await (tx as any).delete(table).where(where);
  const affected = readRowCount(result);
  return { affected, won: affected > 0 };
}

/**
 * drizzle's node-postgres driver hands back the raw `pg.QueryResult` for a
 * statement without `.returning()`, and an array of rows with it. Handle both
 * so a caller can add `.returning()` later without this breaking.
 */
function readRowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const rowCount = (result as { rowCount?: number | null } | null)?.rowCount;
  return typeof rowCount === 'number' ? rowCount : 0;
}

/** `and()` that tolerates `undefined` members, for building guards conditionally. */
export function allOf(...parts: Array<SQL | undefined>): SQL | undefined {
  const present = parts.filter((p): p is SQL => p !== undefined);
  return present.length === 0 ? undefined : and(...present);
}
