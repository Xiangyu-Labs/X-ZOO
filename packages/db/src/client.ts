import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export type Db = NodePgDatabase;
/** The transaction handle `withTx` passes down; repos accept `Db | Tx`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

const JSON_OID = 114;
const JSONB_OID = 3802;

/**
 * `json`/`jsonb` reach drizzle as text, so they are parsed exactly once.
 *
 * node-postgres parses them by default and drizzle's jsonb column then parses
 * any *string* it is handed a second time: a stored `"1900000001"` (a merchant
 * id, a phone number) came back as a number, `"true"` as a boolean, and a
 * schema that expected a string silently fell back to its default.
 *
 * It has to be the driver-wide parser: drizzle passes its own `types` with
 * every query and falls back to `pg.types`, so a pool-level override is never
 * consulted. Every connection in this workspace is made here, and a raw
 * `db.execute` that selects jsonb gets text — read such columns through a
 * drizzle column, or `JSON.parse` them yourself.
 */
const keepText = (value: string): string => value;
pg.types.setTypeParser(JSON_OID, keepText);
pg.types.setTypeParser(JSONB_OID, keepText);

export interface DbOptions {
  /** Pool size. */
  max?: number;
  /**
   * How long a caller waits for a pooled connection before it gets an error
   * (`timeout exceeded when trying to connect`). `0` waits for ever, which is
   * `pg.Pool`'s own default and how a lock-holding transaction can wedge a
   * process (see `createDb`). Default: `DB_POOL_ACQUIRE_TIMEOUT_MS`, else 5 s.
   */
  acquireTimeoutMs?: number;
  /**
   * PostgreSQL's `idle_in_transaction_session_timeout`, sent as a connection
   * option: a session that sits inside an open transaction without running a
   * statement for this long is terminated by the server, which rolls it back
   * and releases its locks. `0` turns it off. Default:
   * `DB_IDLE_IN_TX_TIMEOUT_MS`, else 30 s.
   */
  idleInTransactionTimeoutMs?: number;
  /**
   * Told about a connection that failed outside a query: the server ended it
   * (restart, `idle_in_transaction_session_timeout`, `pg_terminate_backend`)
   * while it sat idle in the pool or idle inside a transaction. The pool
   * already drops such a connection; the caller holding it gets the error on
   * its next statement. Default: ignore.
   */
  onConnectionError?: (error: Error) => void;
}

/** Five seconds: far above any healthy wait for one of ten connections. */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
/** Thirty seconds: no request or job sits idle inside a transaction that long. */
export const DEFAULT_IDLE_IN_TX_TIMEOUT_MS = 30_000;

/** A non-negative integer from the environment, or the fallback. */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer of milliseconds, got "${raw}"`);
  }
  return value;
}

/**
 * The one place a pool is made.
 *
 * Two limits are always on. Without them, a transaction that holds
 * a row lock and then asks the pool for a second connection waits for ever as
 * soon as every other connection is waiting on that lock: `pg.Pool` has no
 * acquire timeout, PostgreSQL has no idle-in-transaction timeout, and the
 * process stops serving with nothing in the log. With them, the starved
 * acquire fails after `acquireTimeoutMs`, the holder's transaction rolls back
 * and the queue behind it moves; a session that a crashed caller left idle in
 * a transaction is ended by the server after `idleInTransactionTimeoutMs`.
 * The fix for the lock holder itself is not to take a second connection
 * (`ctx.config.getIn`, the `tx-pool` guard); these make the next instance of
 * that mistake an error instead of an outage.
 */
export function createDb(url: string, options: DbOptions = {}): DbHandle {
  const acquireTimeoutMs =
    options.acquireTimeoutMs ?? envMs('DB_POOL_ACQUIRE_TIMEOUT_MS', DEFAULT_ACQUIRE_TIMEOUT_MS);
  const idleInTransactionTimeoutMs =
    options.idleInTransactionTimeoutMs ??
    envMs('DB_IDLE_IN_TX_TIMEOUT_MS', DEFAULT_IDLE_IN_TX_TIMEOUT_MS);
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    ...(acquireTimeoutMs > 0 ? { connectionTimeoutMillis: acquireTimeoutMs } : {}),
    ...(idleInTransactionTimeoutMs > 0
      ? { idle_in_transaction_session_timeout: idleInTransactionTimeoutMs }
      : {}),
  });
  // `pg` emits `error` on the pool (idle connection) or on the client (checked
  // out, between statements) when the server ends a session. With no listener
  // that is an uncaught exception and the whole process exits, which is how a
  // server-side timeout meant to free one stuck transaction would take every
  // other request with it. Listened for here, the connection is discarded and
  // only its own caller sees the failure.
  const onConnectionError = options.onConnectionError ?? (() => {});
  pool.on('error', (error) => onConnectionError(error));
  pool.on('connect', (client) => client.on('error', (error) => onConnectionError(error)));
  const db = drizzle(pool, { casing: 'snake_case' });
  return { db, pool, close: () => pool.end() };
}
