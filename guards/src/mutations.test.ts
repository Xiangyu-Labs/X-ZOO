import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MUTATIONS } from '../scripts/mutations/mutations';
import { repoRoot } from './lib/paths';

/**
 * MUT-001 in `docs/invariants.md` needs a test that `pnpm guards` can resolve,
 * and the proof itself is a script (`pnpm --filter @shop/guards mutations`),
 * which runs nightly because it takes minutes and a database. This file checks
 * the catalogue on every PR, statically, so that it cannot rot between runs:
 *
 *  - it still names the ten protections MUT-001 lists, once each;
 *  - every mutant still applies. The search text occurs exactly once in the
 *    live file, so a refactor that moves a protection fails here, not at 3 a.m.;
 *  - every guarding test still exists: the file, and its `describe` title
 *    written in it.
 *
 * Whether each mutant is **killed** is the script's question, not this file's.
 */

const PROTECTIONS = [
  'the payment/cancel order lock',
  'attempt immutability',
  'the gateway-confirmed close',
  'the refund amount freeze',
  'the coupon remaining-count guard',
  'the virtual-card atomic claim',
  'the service-generated refund completion',
  'TLS peer verification',
  'response signature validation',
  'the cancelled-order payment branch',
];

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    count += 1;
  }
  return count;
}

describe('MUT-001 — the mutation catalogue', () => {
  it('names the ten protections MUT-001 lists, once each', () => {
    expect(MUTATIONS.map((mutation) => mutation.protection)).toEqual(PROTECTIONS);
    expect(new Set(MUTATIONS.map((mutation) => mutation.id)).size).toBe(MUTATIONS.length);
  });

  for (const mutation of MUTATIONS) {
    it(`still applies the ${mutation.id} mutant to exactly one place`, () => {
      const source = fs.readFileSync(path.join(repoRoot, mutation.file), 'utf8');
      expect(occurrences(source, mutation.search)).toBe(1);
      expect(mutation.replace).not.toBe(mutation.search);
    });
  }

  for (const mutation of MUTATIONS) {
    it(`still finds every test that guards ${mutation.id}`, () => {
      expect(mutation.tests.length).toBeGreaterThan(0);
      for (const test of mutation.tests) {
        const file = path.join(repoRoot, 'packages/core', test.file);
        expect(fs.existsSync(file), test.file).toBe(true);
        expect(fs.readFileSync(file, 'utf8'), `${test.file} › ${test.describe}`).toContain(
          test.describe,
        );
      }
    });
  }
});
