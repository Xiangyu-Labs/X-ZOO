/**
 * The guard harness.
 *
 * A guard is a pure function over the repository's own text: contracts, route
 * files, permission atoms, config descriptors, the mini-program sources, the
 * migrations, the CI workflow and the rule catalogue. It never starts a server
 * and never opens a database, so `pnpm guards` is a second or two and can run
 * on every commit.
 *
 * Two verdicts:
 *
 *   `fail`  something is wrong now — the guard exits non-zero.
 *   `note`  context worth printing. Never fatal.
 *
 * There is deliberately no "known, fix later" level. A property that is
 * allowed to be false somewhere is an allow-list entry inside the check, with
 * the reason next to it, and every such list is compared exactly: an entry
 * that stops applying is itself a failure, so a list can only shrink.
 */

export type Level = 'fail' | 'note';

export interface Finding {
  level: Level;
  /** File, id or row the finding is about. */
  where: string;
  message: string;
}

export interface CheckResult {
  name: string;
  title: string;
  /** One line printed even when the check passes: what was actually compared. */
  summary: string;
  findings: Finding[];
}

export interface Check {
  name: string;
  title: string;
  run(): CheckResult | Promise<CheckResult>;
}

export function fail(where: string, message: string): Finding {
  return { level: 'fail', where, message };
}

export function note(where: string, message: string): Finding {
  return { level: 'note', where, message };
}

export function defineCheck(
  name: string,
  title: string,
  run: () => CheckResult | Promise<CheckResult>,
): Check {
  return { name, title, run };
}

export function result(
  name: string,
  title: string,
  summary: string,
  findings: Finding[],
): CheckResult {
  return { name, title, summary, findings };
}

export function count(findings: readonly Finding[], level: Level): number {
  return findings.filter((f) => f.level === level).length;
}
