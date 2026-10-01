import { describe, expect, it } from 'vitest';
import { rel } from '../lib/paths';
import { citationProblem, testModules } from './invariants';

const FILES: Record<string, string> = {
  'packages/x/a.test.ts': "describe('outer', () => { it('keeps the rule', () => {}); });",
  'deploy/drill.sh': 'case static/memory-budget)',
};
const read = (file: string): string | null => FILES[file] ?? null;

describe('citationProblem', () => {
  it('resolves a test title and a line of a non-test file', () => {
    expect(citationProblem('packages/x/a.test.ts::outer > keeps the rule', read)).toBeNull();
    expect(citationProblem('deploy/drill.sh::static/memory-budget', read)).toBeNull();
  });

  it('names the missing file, the missing title and its likely rename', () => {
    expect(citationProblem('packages/x/gone.test.ts::anything', read)).toBe(
      'no such file: packages/x/gone.test.ts',
    );
    expect(citationProblem('packages/x/a.test.ts::outer > keeps the rule (CR-1)', read)).toBe(
      'packages/x/a.test.ts has no test named "keeps the rule (CR-1)" — renamed to "keeps the rule"?',
    );
    expect(citationProblem('deploy/drill.sh::static/renamed', read)).toBe(
      'deploy/drill.sh writes no "static/renamed"',
    );
  });

  it('refuses a citation that is not <file>::<test name>', () => {
    expect(citationProblem('just a sentence', read)).toBe(
      '"just a sentence" is not <file>::<test name>',
    );
  });
});

describe('the test-title scan', () => {
  it('reads the mini-program and the packages it is built from', () => {
    const files = testModules().map((file) => rel(file.file));
    for (const root of [
      'apps/mini/src/',
      'packages/api-client/src/',
      'packages/storefront-blocks/src/',
      'e2e/storefront/specs-mini/',
    ]) {
      expect(
        files.some((file) => file.startsWith(root)),
        root,
      ).toBe(true);
    }
    expect(files.some((file) => file.includes('/node_modules/'))).toBe(false);
  });
});
