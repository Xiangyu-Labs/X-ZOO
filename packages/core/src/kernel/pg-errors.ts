/**
 * PostgreSQL errors as they reach a service or `handle()`.
 *
 * node-postgres raises a `DatabaseError` carrying the SQLSTATE `code` and,
 * for an integrity violation, the `constraint` and `table`; drizzle wraps it
 * in a `DrizzleQueryError` whose `cause` is the driver error, and a
 * transaction may wrap it once more. So the code is looked for along the
 * `cause` chain rather than on the error itself.
 */

export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_UNIQUE_VIOLATION = '23505';

export interface PgErrorInfo {
  /** SQLSTATE, e.g. `23503`. */
  code: string;
  constraint: string | undefined;
  table: string | undefined;
  message: string;
  detail: string | undefined;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** The first PostgreSQL error along `error`'s `cause` chain, or null. */
export function pgErrorOf(error: unknown): PgErrorInfo | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      table?: unknown;
      message?: unknown;
      detail?: unknown;
      cause?: unknown;
    };
    if (typeof candidate.code === 'string' && SQLSTATE.test(candidate.code)) {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined,
        table: typeof candidate.table === 'string' ? candidate.table : undefined,
        message: typeof candidate.message === 'string' ? candidate.message : '',
        detail: typeof candidate.detail === 'string' ? candidate.detail : undefined,
      };
    }
    current = candidate.cause;
  }
  return null;
}

export interface ForeignKeyViolation {
  /**
   * `referenced`: a delete (or key change) of a row live rows still point at.
   * `missing`: an insert or update pointing at a row that is not there — most
   * often one deleted a moment ago in another tab.
   */
  kind: 'referenced' | 'missing';
  constraint: string | undefined;
  table: string | undefined;
}

/** A `23503`, told apart by which side of the reference the statement was on. */
export function foreignKeyViolationOf(error: unknown): ForeignKeyViolation | null {
  const pg = pgErrorOf(error);
  if (!pg || pg.code !== PG_FOREIGN_KEY_VIOLATION) return null;
  const referenced =
    /is still referenced/.test(pg.detail ?? '') || /^update or delete on table/.test(pg.message);
  return {
    kind: referenced ? 'referenced' : 'missing',
    constraint: pg.constraint,
    table: pg.table,
  };
}
