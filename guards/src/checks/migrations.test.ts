import { describe, expect, it } from 'vitest';
import { sequenceProblems, unmarkedDestructive } from './migrations';

/** OPS-007 — the statement-level reading the `migrations` check applies to every migration. */
describe('unmarkedDestructive', () => {
  it('passes a migration that only adds', () => {
    const sql = [
      'CREATE TABLE "a" ("id" bigint);',
      '--> statement-breakpoint',
      'ALTER TABLE "a" ADD COLUMN "b" text;',
    ].join('\n');
    expect(unmarkedDestructive(sql)).toEqual([]);
  });

  it('finds an unmarked DROP TABLE, DROP COLUMN and column retype', () => {
    const sql = [
      'DROP TABLE "gone";',
      '--> statement-breakpoint',
      'ALTER TABLE "a" DROP COLUMN "b";',
      '--> statement-breakpoint',
      'ALTER TABLE "a" ALTER COLUMN "c" SET DATA TYPE text;',
    ].join('\n');
    expect(unmarkedDestructive(sql).map((s) => s.kind)).toEqual([
      'DROP TABLE',
      'DROP COLUMN',
      'ALTER COLUMN … TYPE',
    ]);
  });

  it('accepts a destructive statement that carries its own marker', () => {
    const sql = [
      '-- destructive: approved — unread for two releases; deployed with --no-auto-rollback.',
      'ALTER TABLE "a" DROP COLUMN "b";',
    ].join('\n');
    expect(unmarkedDestructive(sql)).toEqual([]);
  });

  it('does not let a marker on one statement bless the next', () => {
    const sql = [
      '-- destructive: approved — the first drop is deliberate.',
      'ALTER TABLE "a" DROP COLUMN "b";',
      '--> statement-breakpoint',
      'ALTER TABLE "a" DROP COLUMN "c";',
    ].join('\n');
    expect(unmarkedDestructive(sql)).toHaveLength(1);
  });

  it('does not read a comment as a statement', () => {
    expect(unmarkedDestructive('-- we might DROP TABLE "x" one day\nSELECT 1;')).toEqual([]);
  });
});

describe('sequenceProblems', () => {
  const ok = {
    files: ['0000_init.sql', '0001_a.sql', '0002_b.sql'],
    journal: ['0000_init', '0001_a', '0002_b'],
    snapshots: ['_journal.json', '0000_snapshot.json', '0001_snapshot.json', '0002_snapshot.json'],
  };

  it('passes migrations that run in order, each in the journal with its snapshot', () => {
    expect(sequenceProblems(ok)).toEqual([]);
  });

  it('finds two pull requests that took the same number', () => {
    const problems = sequenceProblems({
      ...ok,
      files: [...ok.files, '0002_c.sql'],
      journal: [...ok.journal, '0002_c'],
    });
    expect(problems.some((p) => p.startsWith('0002 is used by 0002_b.sql and 0002_c.sql'))).toBe(
      true,
    );
  });

  it('finds a gap, which is what a rename without a journal edit leaves', () => {
    const problems = sequenceProblems({
      files: ['0000_init.sql', '0002_b.sql'],
      journal: ['0000_init', '0002_b'],
      snapshots: ['0000_snapshot.json', '0002_snapshot.json'],
    });
    expect(problems.join('\n')).toContain('skip from 0001 to 0002');
  });

  it('finds a migration the journal does not list, and one it lists twice', () => {
    expect(
      sequenceProblems({ ...ok, journal: ['0000_init', '0001_a'] }).some((p) =>
        p.startsWith('meta/_journal.json does not list'),
      ),
    ).toBe(true);
    expect(
      sequenceProblems({ ...ok, journal: ['0000_init', '0001_a', '0001_a', '0002_b'] }).length,
    ).toBeGreaterThan(0);
  });

  it('finds a migration without its snapshot, and a file that is not numbered', () => {
    expect(
      sequenceProblems({ ...ok, snapshots: ['0000_snapshot.json', '0001_snapshot.json'] }),
    ).toEqual(['meta/0002_snapshot.json is missing: db:generate writes one per migration']);
    expect(sequenceProblems({ ...ok, files: [...ok.files, 'fix.sql'] })[0]).toContain(
      'NNNN_snake_case.sql',
    );
  });
});
