import fs from 'node:fs';
import path from 'node:path';

import { sql } from 'drizzle-orm';

import { createDb } from './client';

/**
 * Which committed migrations the database has not applied yet. Read-only: it
 * runs inside a `read only` transaction and creates nothing, not even the
 * `drizzle` schema the migrator would create.
 *
 *   node db/src/pending.mjs   →   pending=<n>, then one `migration=<tag>` per pending entry
 *
 * `shop upgrade` runs it in the *candidate* worker image before it decides
 * whether the release has to stop the writers: a release with nothing to
 * migrate is deployed without stopping anything. Exit 0 means the answer is
 * on stdout; anything else means it could not tell, and the upgrade then takes
 * the stopping path.
 *
 * It is a file of its own rather than a `--check` flag on `migrate.mjs`
 * because an image built before the flag existed would ignore it and migrate —
 * against live writers. An image without this file fails to run it instead,
 * which is the safe answer.
 *
 * The rule is drizzle's own (`PgDialect.migrate`): take the newest row of
 * `drizzle.__drizzle_migrations` by `created_at`, and every journal entry whose
 * `when` is later than that row's `created_at` is applied. Nothing compares
 * hashes or tags, so neither does this.
 */

interface JournalEntry {
  tag: string;
  when: number;
}

function readJournal(): JournalEntry[] {
  const file = path.resolve(import.meta.dirname, '../migrations/meta/_journal.json');
  const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries?: JournalEntry[] };
  if (!Array.isArray(journal.entries)) throw new Error(`${file} has no entries`);
  return journal.entries;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const entries = readJournal();
  const { db, close } = createDb(url, { max: 1 });
  try {
    const last = await db.transaction(
      async (tx) => {
        const table = await tx.execute<{ present: boolean }>(
          sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
        );
        if (!table.rows[0]?.present) return null;
        // `order by … desc limit 1`, not `max()`: the migrator's own query, which
        // puts a NULL `created_at` first, and the two must agree on that row.
        const newest = await tx.execute<{ created_at: string | number | null }>(
          sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
        );
        const row = newest.rows[0];
        return row ? Number(row.created_at) : null;
      },
      { accessMode: 'read only' },
    );
    const pending = entries.filter((entry) => last === null || last < entry.when);
    process.stdout.write(`pending=${pending.length}\n`);
    for (const entry of pending) process.stdout.write(`migration=${entry.tag}\n`);
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
