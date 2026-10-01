import { describe, expect, it } from 'vitest';
import { contractsAndRoutes } from './contracts';
import type { Finding } from '../framework';

/**
 * ROUTE-001 in `docs/invariants.md`: "every registered route resolves to
 * a real handler, and nothing else is reachable".
 *
 * The check itself is what asserts it; this file is the test the catalogue can
 * point at, and it splits the check's findings by direction so a failure names
 * which half broke. Both halves matter and they fail differently: a contract
 * with no route file is a 404 on a URL the client believes in, and a route file
 * with no contract is a handler nobody validates, authorises or audits.
 */

const findings: Finding[] = (await contractsAndRoutes.run()).findings;
const failures = findings.filter((f) => f.level === 'fail');
const say = (subset: Finding[]): string => subset.map((f) => `${f.where}: ${f.message}`).join('\n');

describe('contracts and route files', () => {
  it('matches every contract to a route file that exports its method', () => {
    const forward = failures.filter(
      (f) =>
        f.message.includes('has no route file') ||
        f.message.includes('does not export') ||
        f.message.includes('folder parameter'),
    );
    expect(say(forward)).toBe('');
  });

  it('leaves no route file that no contract describes', () => {
    const backward = failures.filter(
      (f) =>
        f.message.includes('no contract describes') ||
        f.message.includes('exports no HTTP method') ||
        f.message.includes('same URL shape'),
    );
    expect(say(backward)).toBe('');
  });

  it('accounts for every failure under one of those two headings', () => {
    const uncategorised = failures.filter(
      (f) =>
        !f.message.includes('has no route file') &&
        !f.message.includes('does not export') &&
        !f.message.includes('folder parameter') &&
        !f.message.includes('no contract describes') &&
        !f.message.includes('exports no HTTP method') &&
        !f.message.includes('same URL shape'),
    );
    expect(say(uncategorised)).toBe('');
  });
});
