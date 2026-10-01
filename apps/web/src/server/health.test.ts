import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATIONS, expectedMigrations } from './health';

/**
 * The readiness check's migration count comes from the drizzle journal, which
 * the web bundle inlines at build time. These tests pin that it is the journal
 * on disk — not a number somebody has to remember to bump.
 */
describe('readiness / EXPECTED_MIGRATIONS', () => {
  const journalPath = fileURLToPath(
    new URL('../../../../packages/db/migrations/meta/_journal.json', import.meta.url),
  );
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };

  it('OPS-021 — is the number of entries in the journal packages/db ships', () => {
    expect(EXPECTED_MIGRATIONS).toBe(journal.entries.length);
    // A journal whose last entry is not at index length-1 means an entry was
    // removed by hand, which would make a count comparison meaningless.
    expect(journal.entries.at(-1)?.idx).toBe(journal.entries.length - 1);
  });

  it('OPS-021 — follows the journal: one more migration is one more expected', () => {
    const next = { entries: [...journal.entries, { idx: journal.entries.length, tag: 'next' }] };
    expect(expectedMigrations(next)).toBe(EXPECTED_MIGRATIONS + 1);
  });

  it('OPS-021 — health.ts carries no hand-typed count', () => {
    const source = readFileSync(fileURLToPath(new URL('./health.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/EXPECTED_MIGRATIONS\s*=\s*\d/);
  });
});
