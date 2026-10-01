/**
 * `pnpm --filter @shop/guards mutations` — MUT-001, mutation testing of the
 * ten protections.
 *
 * For every entry in `mutations.ts`:
 *
 *  1. the tests that guard it run once against an **unmutated** copy, and must
 *     run (at least one test per pattern) and pass — a baseline that fails or
 *     selects nothing makes the mutation result meaningless;
 *  2. the protection is removed by one literal edit, asserted to match exactly
 *     once, in that copy;
 *  3. the same tests run again and at least one of them must **fail**. A mutant
 *     whose tests still pass is a survivor: the protection is not guarded.
 *
 * The live tree is never written. The copy is a `git archive` of the revision
 * (default `HEAD`) into a fresh directory under `os.tmpdir()` — `packages`
 * plus the three root files the workspace needs — whose `node_modules` are the
 * live ones: the root one is a symlink, and each package's (pnpm's relative
 * symlinks, no files) is copied link-for-link so that `@shop/*` resolves inside
 * the copy and every third-party package resolves into the live store. No
 * install, no network; the copy costs about a second.
 *
 * The integration tests need Docker, exactly as `pnpm test:int` does: each
 * vitest run starts its own PostgreSQL and Redis through the Testcontainers
 * harness, unless `SHOP_TEST_PG_URL` / `SHOP_TEST_REDIS_URL` point at a warm
 * pair. Runs are sequential; the harness is not built to share a template
 * database between concurrent runs.
 *
 * Exit status: 0 only when every mutation matched, every baseline passed and
 * every mutant was killed.
 *
 *   pnpm --filter @shop/guards mutations
 *   pnpm --filter @shop/guards mutations --only order-lock,response-signature
 *   pnpm --filter @shop/guards mutations --working-tree   # include uncommitted edits
 *   pnpm --filter @shop/guards mutations --ref <rev> --keep --json out.json
 *   pnpm --filter @shop/guards mutations --scratch /tmp/mut --timeout 600
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MUTATIONS, type GuardingTest, type Mutation, type TestProject } from './mutations';

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

interface Options {
  only: Set<string> | null;
  ref: string;
  workingTree: boolean;
  keep: boolean;
  json: string | null;
  /** Where the copy is made. Keep it short: tsx and vitest put sockets under it. */
  scratchParent: string;
  /** Per vitest run. A mutant that hangs past it counts as killed, and says so. */
  timeoutMs: number;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    only: null,
    ref: 'HEAD',
    workingTree: false,
    keep: false,
    json: null,
    scratchParent: tmpdir(),
    timeoutMs: 10 * 60_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--') continue;
    else if (arg === '--only') options.only = new Set(value().split(',').filter(Boolean));
    else if (arg === '--ref') options.ref = value();
    else if (arg === '--working-tree') options.workingTree = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--json') options.json = path.resolve(value());
    else if (arg === '--scratch') options.scratchParent = path.resolve(value());
    else if (arg === '--timeout') options.timeoutMs = Number(value()) * 1000;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (options.only) {
    const known = new Set(MUTATIONS.map((m) => m.id));
    const unknown = [...options.only].filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`unknown mutation id(s): ${unknown.join(', ')}`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// the copy
// ---------------------------------------------------------------------------

const guardsDir = path.resolve(import.meta.dirname, '../..');
const liveRoot = path.resolve(guardsDir, '..');

/** What the copy needs: the workspace root files and the packages. */
const COPIED = ['package.json', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'packages'];

function log(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function materialise(scratch: string, options: Options): string {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: liveRoot,
    encoding: 'utf8',
  }).trim();
  const workspaceRel = path.relative(repoRoot, liveRoot);
  const copyRoot = path.join(scratch, workspaceRel);

  if (options.workingTree) {
    for (const entry of COPIED) {
      cpSync(path.join(liveRoot, entry), path.join(copyRoot, entry), {
        recursive: true,
        verbatimSymlinks: true,
        filter: (src) => !/[\\/](node_modules|\.turbo|dist|coverage)([\\/]|$)/.test(src),
      });
    }
  } else {
    const paths = COPIED.map((entry) =>
      path.posix.join(workspaceRel.split(path.sep).join('/'), entry),
    );
    execFileSync(
      'bash',
      [
        '-o',
        'pipefail',
        '-c',
        'git -C "$1" archive --format=tar "$2" -- "${@:4}" | tar -x -C "$3"',
        'archive',
        repoRoot,
        options.ref,
        scratch,
        ...paths,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
  }

  // Third-party packages: the live store, through one symlink.
  symlinkSync(path.join(liveRoot, 'node_modules'), path.join(copyRoot, 'node_modules'), 'dir');

  // Workspace packages: pnpm's per-package `node_modules` hold only relative
  // symlinks (`@shop/db -> ../../../db`, `zod -> ../../../node_modules/.pnpm/…`),
  // so copying the links themselves points `@shop/*` at the copy and the rest
  // at the live store.
  for (const pkg of readdirSync(path.join(copyRoot, 'packages'))) {
    const live = path.join(liveRoot, 'packages', pkg, 'node_modules');
    if (!existsSync(live)) continue;
    cpSync(live, path.join(copyRoot, 'packages', pkg, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => !/[\\/]\.vite(-temp)?([\\/]|$)/.test(src),
    });
  }

  // `*.gen.ts` are gitignored, and `turbo run test:int` runs `gen` first for
  // the same reason. Contracts before everything else: that is turbo's `^gen`.
  const packages = readdirSync(path.join(copyRoot, 'packages'))
    .filter((pkg) => {
      const manifest = path.join(copyRoot, 'packages', pkg, 'package.json');
      if (!existsSync(manifest)) return false;
      const scripts = (JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: object }).scripts;
      return scripts !== undefined && 'gen' in scripts;
    })
    .sort((a, b) => Number(b === 'contracts') - Number(a === 'contracts'));
  for (const pkg of packages) {
    execFileSync('pnpm', ['run', '--silent', 'gen'], {
      cwd: path.join(copyRoot, 'packages', pkg),
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  }
  return copyRoot;
}

// ---------------------------------------------------------------------------
// running vitest
// ---------------------------------------------------------------------------

interface AssertionResult {
  ancestorTitles: string[];
  title: string;
  fullName: string;
  status: 'passed' | 'failed' | 'skipped' | 'pending' | 'todo' | 'disabled';
  failureMessages?: string[];
}

interface FileResult {
  name: string;
  status: string;
  message?: string;
  assertionResults: AssertionResult[];
}

interface VitestReport {
  testResults: FileResult[];
}

interface RunOutcome {
  report: VitestReport | null;
  timedOut: boolean;
  exitCode: number | null;
  log: string;
}

let runSequence = 0;

async function runVitest(
  copyRoot: string,
  logDir: string,
  label: string,
  project: TestProject,
  tests: readonly GuardingTest[],
  timeoutMs: number,
): Promise<RunOutcome> {
  runSequence += 1;
  const stem = `${String(runSequence).padStart(2, '0')}-${label}-${project}`;
  const jsonPath = path.join(logDir, `${stem}.json`);
  const logPath = path.join(logDir, `${stem}.log`);
  const core = path.join(copyRoot, 'packages', 'core');
  const vitest = path.join(core, 'node_modules', 'vitest', 'vitest.mjs');
  const files = [...new Set(tests.map((t) => t.file))];
  // `-t` only narrows the run; `resultsFor` makes the exact selection from the
  // report. A `describe` title is a prefix of the full name whatever separator
  // vitest joins the names with.
  const pattern = `^(?:${[...new Set(tests.map((t) => escapeRegExp(t.describe)))].join('|')})`;

  const args = [
    vitest,
    'run',
    '--project',
    project,
    ...files,
    '-t',
    pattern,
    '--reporter=json',
    `--outputFile=${jsonPath}`,
  ];

  const chunks: Buffer[] = [];
  const child = spawn(process.execPath, args, {
    cwd: core,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
  activeChildren.add(child.pid!);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid!);
  }, timeoutMs);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
  });
  clearTimeout(timer);
  activeChildren.delete(child.pid!);

  const output = Buffer.concat(chunks).toString('utf8');
  writeFileSync(logPath, output);
  let report: VitestReport | null = null;
  if (existsSync(jsonPath)) {
    try {
      report = JSON.parse(readFileSync(jsonPath, 'utf8')) as VitestReport;
    } catch {
      report = null;
    }
  }
  return { report, timedOut, exitCode, log: output };
}

const activeChildren = new Set<number>();

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/** Results from one report that belong to one guarding test. */
function resultsFor(report: VitestReport, test: GuardingTest): AssertionResult[] {
  const suffix = `/${test.file.split(path.sep).join('/')}`;
  const title = test.it === undefined ? null : new RegExp(test.it);
  return report.testResults
    .filter((file) => file.name.split(path.sep).join('/').endsWith(suffix))
    .flatMap((file) => file.assertionResults)
    .filter(
      (a) =>
        a.ancestorTitles[0] === test.describe &&
        (title === null || title.test(a.title)) &&
        (a.status === 'passed' || a.status === 'failed'),
    );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function describeTest(test: GuardingTest): string {
  return `${test.describe}${test.it === undefined ? '' : ` > /${test.it}/`}`;
}

/** A file that failed without running anything: an import error, a hook that threw. */
function fileErrorsFor(report: VitestReport, tests: readonly GuardingTest[]): string[] {
  const suffixes = tests.map((t) => `/${t.file.split(path.sep).join('/')}`);
  return report.testResults
    .filter((file) => suffixes.some((s) => file.name.split(path.sep).join('/').endsWith(s)))
    .filter((file) => file.status === 'failed' && (file.message ?? '').length > 0)
    .map((file) => `${path.basename(file.name)}: ${firstLine(file.message ?? '')}`);
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  ).slice(0, 200);
}

function byProject(tests: readonly GuardingTest[]): Map<TestProject, GuardingTest[]> {
  const groups = new Map<TestProject, GuardingTest[]>();
  for (const test of tests) {
    const group = groups.get(test.project) ?? [];
    group.push(test);
    groups.set(test.project, group);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

type Verdict = 'killed' | 'SURVIVED' | 'no-match' | 'baseline-failed' | 'error';

interface Row {
  mutation: Mutation;
  match: number;
  baseline: { ok: boolean; notes: string[] };
  verdict: Verdict;
  killers: string[];
  notes: string[];
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    count += 1;
  }
  return count;
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing to write outside the scratch copy: ${target}`);
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const selected = MUTATIONS.filter((m) => options.only === null || options.only.has(m.id));
  const started = Date.now();

  mkdirSync(options.scratchParent, { recursive: true });
  const scratch = mkdtempSync(path.join(options.scratchParent, 'shop-mutations-'));
  const cleanup = (): void => {
    for (const pid of activeChildren) killGroup(pid);
    if (!options.keep) rmSync(scratch, { recursive: true, force: true });
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    cleanup();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const source = options.workingTree ? 'the working tree' : options.ref;
    log(`MUT-001: ${selected.length} mutation(s), copying ${source} into ${scratch}`);
    const copyRoot = materialise(scratch, options);
    const logDir = path.join(scratch, 'logs');
    mkdirSync(logDir, { recursive: true });

    // --- every mutation must match exactly once, before anything runs --------
    const rows: Row[] = selected.map((mutation) => {
      const target = path.join(copyRoot, mutation.file);
      const text = existsSync(target) ? readFileSync(target, 'utf8') : '';
      const match = countOccurrences(text, mutation.search);
      return {
        mutation,
        match,
        baseline: { ok: false, notes: [] },
        verdict: match === 1 ? 'error' : 'no-match',
        killers: [],
        notes:
          match === 1
            ? []
            : [
                existsSync(target)
                  ? `search text matches ${match} times in ${mutation.file} (must be exactly 1)`
                  : `${mutation.file} does not exist`,
              ],
      };
    });

    // --- baseline: one run per project over every guarding test --------------
    const allTests = rows.filter((r) => r.match === 1).flatMap((r) => r.mutation.tests);
    const baselineReports = new Map<TestProject, RunOutcome>();
    for (const [project, tests] of byProject(allTests)) {
      log(`baseline (${project}): ${new Set(tests.map((t) => t.file)).size} file(s)`);
      baselineReports.set(
        project,
        await runVitest(copyRoot, logDir, 'baseline', project, tests, options.timeoutMs),
      );
    }

    for (const row of rows) {
      if (row.match !== 1) continue;
      for (const test of row.mutation.tests) {
        const outcome = baselineReports.get(test.project)!;
        if (!outcome.report) {
          row.baseline.notes.push(`no report from the ${test.project} baseline run`);
          continue;
        }
        const results = resultsFor(outcome.report, test);
        const failed = results.filter((r) => r.status === 'failed');
        if (results.length === 0) {
          const fileErrors = fileErrorsFor(outcome.report, [test]);
          row.baseline.notes.push(
            fileErrors.length > 0
              ? `${test.file}: ${fileErrors.join('; ')}`
              : `no test in ${test.file} matches ${describeTest(test)}`,
          );
        } else if (failed.length > 0) {
          row.baseline.notes.push(
            ...failed.map(
              (f) => `fails unmutated: ${f.fullName} — ${firstLine(f.failureMessages?.[0] ?? '')}`,
            ),
          );
        }
      }
      row.baseline.ok = row.baseline.notes.length === 0;
      if (!row.baseline.ok) {
        row.verdict = 'baseline-failed';
        row.notes.push(...row.baseline.notes);
      }
    }

    // --- the mutants, one at a time ------------------------------------------
    for (const row of rows) {
      if (row.match !== 1 || !row.baseline.ok) continue;
      const { mutation } = row;
      const target = path.join(copyRoot, mutation.file);
      assertInside(scratch, target);
      const original = readFileSync(target, 'utf8');
      const mutated = original.replace(mutation.search, () => mutation.replace);
      if (mutated === original) throw new Error(`${mutation.id}: the edit changed nothing`);

      log(`mutant ${mutation.id}: ${mutation.summary}`);
      writeFileSync(target, mutated);
      try {
        const verdicts: Verdict[] = [];
        for (const [project, tests] of byProject(mutation.tests)) {
          const outcome = await runVitest(
            copyRoot,
            logDir,
            mutation.id,
            project,
            tests,
            options.timeoutMs,
          );
          if (outcome.timedOut) {
            row.killers.push(`(${project} run timed out after ${options.timeoutMs / 1000}s)`);
            verdicts.push('killed');
            continue;
          }
          if (!outcome.report) {
            row.notes.push(`${project}: no report (exit ${outcome.exitCode})`);
            verdicts.push('error');
            continue;
          }
          const results = tests.flatMap((test) => resultsFor(outcome.report!, test));
          const failed = results.filter((r) => r.status === 'failed');
          if (results.length === 0) {
            // The mutation broke the module rather than the behaviour: that is
            // a bad mutation, not a kill.
            row.notes.push(
              `${project}: nothing ran under the mutation — ${fileErrorsFor(outcome.report, tests).join('; ') || 'no matching tests'}`,
            );
            verdicts.push('error');
            continue;
          }
          row.killers.push(...new Set(failed.map((f) => f.fullName)));
          verdicts.push(failed.length > 0 ? 'killed' : 'SURVIVED');
        }
        row.verdict = verdicts.includes('error')
          ? 'error'
          : verdicts.includes('killed')
            ? 'killed'
            : 'SURVIVED';
      } finally {
        writeFileSync(target, original);
      }
    }

    report(rows, Date.now() - started);
    if (options.json) {
      writeFileSync(
        options.json,
        `${JSON.stringify(
          rows.map((r) => ({
            id: r.mutation.id,
            protection: r.mutation.protection,
            file: r.mutation.file,
            mutation: r.mutation.summary,
            tests: r.mutation.tests,
            baselinePassed: r.baseline.ok,
            verdict: r.verdict,
            killers: r.killers,
            notes: r.notes,
          })),
          null,
          2,
        )}\n`,
      );
    }
    if (options.keep) log(`scratch copy kept at ${scratch}`);
    return rows.every((r) => r.verdict === 'killed') ? 0 : 1;
  } finally {
    cleanup();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

function report(rows: readonly Row[], elapsedMs: number): void {
  log();
  log('| protection | file | mutation | test | baseline pass? | mutant killed? |');
  log('| --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    const m = row.mutation;
    const tests = m.tests
      .map((t) => `\`${path.basename(t.file)}\` ${describeTest(t)}`)
      .join('<br>');
    const baseline = row.match !== 1 ? 'n/a' : row.baseline.ok ? 'yes' : 'NO';
    const killed =
      row.verdict === 'killed'
        ? 'yes'
        : row.verdict === 'SURVIVED'
          ? '**NO — survived**'
          : `n/a (${row.verdict})`;
    log(
      `| ${m.protection} | \`${m.file.replace(/^packages\/core\/src\//, '')}\` | ${m.summary} | ${tests} | ${baseline} | ${killed} |`,
    );
  }
  log();
  for (const row of rows) {
    const head = `${row.verdict === 'killed' ? 'ok  ' : 'FAIL'} ${row.mutation.id}`;
    log(`${head}: ${row.verdict}`);
    for (const killer of row.killers) log(`       killed by: ${killer}`);
    for (const note of row.notes) log(`       ${note}`);
  }
  const killed = rows.filter((r) => r.verdict === 'killed').length;
  const survived = rows.filter((r) => r.verdict === 'SURVIVED').length;
  log();
  log(
    `MUT-001: ${killed} killed, ${survived} survived, ${rows.length - killed - survived} not run ` +
      `(no-match / baseline / error) — ${Math.round(elapsedMs / 1000)}s`,
  );
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(2);
  },
);
