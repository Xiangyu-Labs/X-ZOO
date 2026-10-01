import { describe, expect, it } from 'vitest';
import { closest, mentions, splitCitation, titleMatches, titlesIn } from './test-titles';

describe('titlesIn', () => {
  it('reads quoted, template and each-table titles, unescaped', () => {
    const source = [
      "describe('outer', () => {",
      '  it("double \\"quoted\\"", () => {});',
      '  it(`refuses a ${label} amount`, () => {});',
      "  it.each([1, 2])('row %s', () => {});",
      "  test.skip('skipped', () => {});",
      '});',
    ].join('\n');
    expect(titlesIn(source)).toEqual([
      'outer',
      'double "quoted"',
      'refuses a ${label} amount',
      'row %s',
      'skipped',
    ]);
  });
});

describe('titleMatches', () => {
  it('matches exactly, or across a template hole or a <hole> in the citation', () => {
    expect(titleMatches('refuses a short amount', 'refuses a short amount')).toBe(true);
    expect(titleMatches('refuses a ${label} amount', 'refuses a short amount')).toBe(true);
    expect(titleMatches('refuses a short amount', 'refuses <each of five>')).toBe(true);
    expect(titleMatches('refuses a short amount', 'refuses a long amount')).toBe(false);
  });
});

describe('mentions', () => {
  it('finds a case id or a shell pass name on one line', () => {
    const drill =
      'case upgrade/failed-migration-ends-on-previous)\npass "a first publish creates sha-$sha_a"';
    expect(mentions(drill, 'upgrade/failed-migration-ends-on-previous')).toBe(true);
    expect(mentions(drill, 'a first publish creates sha-<sha>')).toBe(true);
    expect(mentions(drill, 'upgrade/renamed')).toBe(false);
  });
});

describe('splitCitation', () => {
  it('splits the file from the leaf title', () => {
    expect(splitCitation('a/b.test.ts::outer > refuses <each of five>')).toEqual({
      file: 'a/b.test.ts',
      leaf: 'refuses <each of five>',
    });
    expect(splitCitation('no separator')).toBeNull();
  });
});

describe('closest', () => {
  it('suggests the title a renamed test probably has now', () => {
    const titles = ['has the kernel schema', 'refuses a second delete'];
    expect(closest('has the kernel schema this package owns', titles)).toBe(
      'has the kernel schema',
    );
    expect(closest('something else entirely', titles)).toBeNull();
  });
});
