/**
 * Reading test names out of test files, and matching a cited name against them.
 *
 * Pure text: nothing here imports or runs a test. The catalogue cites a test as
 * `<file>::<describe> > <it>`, the way vitest reports it; the leaf (the part
 * after the last ` > `) is the one string written out in the file, so the leaf
 * is what gets matched.
 */

/**
 * Every `it(…)` / `test(…)` / `describe(…)` title written in a file.
 *
 * Three forms are read: a plain quoted string, a template literal (a test
 * written in a loop), and `it.each(table)('title')`, where the title is in the
 * *second* argument list. Escapes are unescaped, because a title that names a
 * config group writes it as \`${group.group}\` and the backslashes are not part
 * of what vitest reports.
 */
export function titlesIn(source: string): string[] {
  const titles: string[] = [];
  for (const match of source.matchAll(
    /\b(?:it|test|describe)(?:\.\w+)*\s*(?:\([^()]*\)\s*)?\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`)/g,
  )) {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    titles.push(raw.replace(/\\(.)/g, '$1'));
  }
  return titles;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does a written title name this test?
 *
 * Two kinds of hole have to line up. A test written in a `for` loop has a
 * template title — `` it(`refuses a ${label} amount…`) `` — and the catalogue
 * records the name vitest reports for one iteration. A citation that covers a
 * whole table writes the hole itself: `refuses <each of five>`. Both sides
 * become `.*` and the comparison is on the literal text around them, so a
 * renamed test still fails while a parameterised one resolves.
 */
export function titleMatches(written: string, wanted: string): boolean {
  if (written === wanted) return true;
  if (!/\$\{|</.test(written) && !/</.test(wanted)) return false;
  const holes = /\$\{[^}]*\}|<[^>]*>/g;
  const toPattern = (text: string): string => text.split(holes).map(escape).join('.*');
  return (
    new RegExp(`^${toPattern(written)}$`).test(wanted) ||
    new RegExp(`^${toPattern(wanted)}$`).test(written)
  );
}

/**
 * Does this file write `leaf` on one of its lines?
 *
 * Not every proof is a vitest test. The deploy rehearsal
 * (`deploy/rehearsal/drill.sh`) names stable case ids, a shell suite calls
 * `pass '<name>'`, and a guard check's "test name" is the message its finding
 * carries. None of those are `it(…)`, so they are matched as text.
 *
 * The match is per line, so a hole cannot bridge two unrelated statements, and
 * the holes are the two `titleMatches` knows plus the shell's bare `$var`.
 * It is a substring match and deliberately so: renaming a case id still breaks
 * the citation, which is the property that matters.
 */
export function mentions(source: string, leaf: string): boolean {
  const holes = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|<[^>]*>/g;
  const expression = new RegExp(leaf.split(holes).map(escape).join('.*'));
  return source.split('\n').some((line) => expression.test(line));
}

/** Test files are read for titles; anything else (shell, guard checks) as text. */
export function isTestModule(file: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

/** The name vitest reports, split into the leaf and the file. */
export function splitCitation(citation: string): { file: string; leaf: string } | null {
  const split = citation.indexOf('::');
  if (split < 0) return null;
  const file = citation.slice(0, split).trim();
  const name = citation.slice(split + 2).trim();
  // ` > ` with spaces: `refuses <each of five>` has a `>` of its own.
  const leaf = (name.split(' > ').at(-1) ?? name).trim();
  if (!file || !leaf) return null;
  return { file, leaf };
}

/** Word overlap, for suggesting the title a stale citation probably meant. */
export function closest(wanted: string, titles: readonly string[]): string | null {
  const words = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 2),
    );
  const want = words(wanted);
  let best: { title: string; score: number } | null = null;
  for (const title of titles) {
    const have = words(title);
    let shared = 0;
    for (const word of want) if (have.has(word)) shared += 1;
    const score = shared / Math.max(want.size, have.size, 1);
    if (!best || score > best.score) best = { title, score };
  }
  return best && best.score >= 0.5 ? best.title : null;
}
