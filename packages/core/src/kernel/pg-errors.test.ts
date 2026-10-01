import { describe, expect, it } from 'vitest';
import { foreignKeyViolationOf, pgErrorOf } from './pg-errors';

/** node-postgres' DatabaseError, as drizzle wraps it. */
const wrapped = (pg: Record<string, string>): Error =>
  Object.assign(new Error('Failed query: …'), {
    cause: Object.assign(new Error(pg.message ?? ''), pg),
  });

describe('pgErrorOf', () => {
  it('finds the SQLSTATE on the driver error drizzle wraps', () => {
    expect(pgErrorOf(wrapped({ code: '23505', constraint: 'x_uq' }))).toMatchObject({
      code: '23505',
      constraint: 'x_uq',
    });
  });

  it('ignores codes that are not SQLSTATEs and non-errors', () => {
    expect(pgErrorOf(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBeNull();
    expect(pgErrorOf('nope')).toBeNull();
    expect(pgErrorOf(null)).toBeNull();
  });
});

describe('foreignKeyViolationOf', () => {
  it('reads a delete of a referenced row as referenced', () => {
    expect(
      foreignKeyViolationOf(
        wrapped({
          code: '23503',
          message:
            'update or delete on table "a" violates foreign key constraint "b_a_fk" on table "b"',
          detail: 'Key (id)=(1) is still referenced from table "b".',
          constraint: 'b_a_fk',
          table: 'b',
        }),
      ),
    ).toEqual({ kind: 'referenced', constraint: 'b_a_fk', table: 'b' });
  });

  it('reads an insert pointing at a missing row as missing', () => {
    expect(
      foreignKeyViolationOf(
        wrapped({
          code: '23503',
          message: 'insert or update on table "b" violates foreign key constraint "b_a_fk"',
          detail: 'Key (a_id)=(9) is not present in table "a".',
        }),
      )?.kind,
    ).toBe('missing');
  });

  it('is null for any other code', () => {
    expect(foreignKeyViolationOf(wrapped({ code: '23505' }))).toBeNull();
  });
});
