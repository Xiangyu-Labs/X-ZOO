import fs from 'node:fs';
import path from 'node:path';
import { defineCheck, fail, result, type Finding } from '../framework';
import { migrationsDir, rel } from '../lib/paths';

/**
 * Migrations stay additive unless somebody says otherwise in writing (OPS-007).
 *
 * `shop upgrade` rolls a failed release back to the previous digests
 * *unattended*: a stack that serves is a better place to end than a stack that
 * is down. That holds only while the previous image tolerates the new schema,
 * which is true while migrations only add. Once one drops a table or a column,
 * or retypes one, the previous image throws on a table shape it was never
 * compiled against, and the automatic rollback turns a failed release into an
 * outage.
 *
 * So a destructive statement is allowed, and it has to be marked:
 *
 *     --> statement-breakpoint
 *     -- destructive: approved — orders.old_ref has been unread for two
 *     -- releases, so the previous image never reads the column either.
 *     ALTER TABLE "orders" DROP COLUMN "old_ref";
 *
 * The marker is per statement, not per file: one line at the top of a
 * migration would bless every statement under it, including ones added later
 * by somebody who never read this. Marking a statement does not make it safe;
 * it records that its author knew the rollback rule applies to that release.
 */

export const DESTRUCTIVE_MARKER = '-- destructive: approved';

/** Drizzle's spellings, and the ones a hand-written migration would use. */
const DESTRUCTIVE = [
  { name: 'DROP TABLE', pattern: /\bDROP\s+TABLE\b/i },
  { name: 'DROP COLUMN', pattern: /\bDROP\s+COLUMN\b/i },
  // `ALTER COLUMN … TYPE` is drizzle's `SET DATA TYPE`; both rewrite a column
  // the previous image still reads.
  { name: 'ALTER COLUMN … TYPE', pattern: /\bALTER\s+COLUMN\b[\s\S]*?\b(?:SET\s+DATA\s+)?TYPE\b/i },
];

/** SQL with its `--` comments removed, so a comment cannot look like a statement. */
function withoutComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

export interface UnmarkedStatement {
  /** Which destructive shape the statement has. */
  kind: string;
  /** The statement's first lines, for the finding. */
  excerpt: string;
}

/** Every destructive statement in one migration that carries no marker of its own. */
export function unmarkedDestructive(sql: string): UnmarkedStatement[] {
  const out: UnmarkedStatement[] = [];
  // One chunk per statement, which is what makes the marker per statement.
  for (const statement of sql.split('--> statement-breakpoint')) {
    const code = withoutComments(statement);
    for (const { name, pattern } of DESTRUCTIVE) {
      if (!pattern.test(code) || statement.includes(DESTRUCTIVE_MARKER)) continue;
      out.push({
        kind: name,
        excerpt: statement.trim().split('\n').slice(0, 2).join(' '),
      });
    }
  }
  return out;
}

/**
 * Migrations are numbered in the order they ship: `0000`, `0001`, … with no
 * gap and no repeat, each listed once in drizzle's journal and followed by its
 * snapshot. Two pull requests written side by side each take the next number,
 * so the second to merge finds its number taken. Git often merges that without
 * a conflict (two different file names), and drizzle then applies whichever it
 * lists, in an order nobody chose. A pull request that finds its number taken
 * renumbers: rename the `.sql`, regenerate the snapshot (`pnpm --filter
 * @shop/db db:generate`), and keep the journal in step.
 */
export function sequenceProblems(input: {
  /** The `.sql` file names in the migrations directory. */
  files: readonly string[];
  /** `tag` of every journal entry, in journal order. */
  journal: readonly string[];
  /** The file names in `meta/`. */
  snapshots: readonly string[];
}): string[] {
  const problems: string[] = [];
  const byNumber = new Map<number, string[]>();
  for (const file of input.files) {
    const number = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file)?.[1];
    if (number === undefined) {
      problems.push(`${file}: a migration is named \`NNNN_snake_case.sql\``);
      continue;
    }
    byNumber.set(Number(number), [...(byNumber.get(Number(number)) ?? []), file]);
  }
  for (const [number, names] of byNumber) {
    if (names.length > 1) {
      problems.push(
        `${String(number).padStart(4, '0')} is used by ${names.join(' and ')}: ` +
          'the one that merged second renumbers (rename the .sql, regenerate the snapshot)',
      );
    }
  }
  const numbers = [...byNumber.keys()].sort((a, b) => a - b);
  numbers.forEach((number, index) => {
    if (number !== index) {
      problems.push(
        `migration numbers skip from ${String(index).padStart(4, '0')} to ` +
          `${String(number).padStart(4, '0')}: they run 0000, 0001, … with no gap`,
      );
    }
  });
  const tags = [...byNumber.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, names]) => (names[0] ?? '').replace(/\.sql$/, ''));
  if (tags.length !== input.journal.length || tags.some((tag, i) => tag !== input.journal[i])) {
    problems.push(
      'meta/_journal.json does not list the migrations in the directory, once each, in order ' +
        `(journal: ${input.journal.length} entries, directory: ${tags.length} files)`,
    );
  }
  for (const number of numbers) {
    const snapshot = `${String(number).padStart(4, '0')}_snapshot.json`;
    if (!input.snapshots.includes(snapshot)) {
      problems.push(`meta/${snapshot} is missing: db:generate writes one per migration`);
    }
  }
  return problems;
}

export const migrations = defineCheck(
  'migrations',
  'migrations are numbered without a gap or a repeat, and every destructive statement is marked, so the unattended rollback stays safe',
  () => {
    const findings: Finding[] = [];
    const files = fs.existsSync(migrationsDir)
      ? fs
          .readdirSync(migrationsDir)
          .filter((name) => name.endsWith('.sql'))
          .sort()
      : [];
    // `0000_init.sql` has existed since the schema landed; an empty list means
    // the directory moved and this check is silently reading nothing.
    if (files.length === 0) {
      findings.push(fail(rel(migrationsDir), 'holds no migrations — the directory moved?'));
    }
    const metaDir = path.join(migrationsDir, 'meta');
    const journalFile = path.join(metaDir, '_journal.json');
    const journal: { entries: { tag: string }[] } = fs.existsSync(journalFile)
      ? JSON.parse(fs.readFileSync(journalFile, 'utf8'))
      : { entries: [] };
    for (const problem of sequenceProblems({
      files,
      journal: journal.entries.map((entry) => entry.tag),
      snapshots: fs.existsSync(metaDir) ? fs.readdirSync(metaDir) : [],
    })) {
      findings.push(fail(rel(migrationsDir), problem));
    }
    for (const name of files) {
      const file = path.join(migrationsDir, name);
      for (const statement of unmarkedDestructive(fs.readFileSync(file, 'utf8'))) {
        findings.push(
          fail(
            rel(file),
            `${statement.kind} with no \`${DESTRUCTIVE_MARKER}\` marker on the statement breaks ` +
              `the unattended rollback (OPS-007): ${statement.excerpt}`,
          ),
        );
      }
    }
    return result(
      'migrations',
      'db migrations',
      `${files.length} migration file(s) in order; every destructive statement marked`,
      findings,
    );
  },
);
