import fs from 'node:fs';
import path from 'node:path';
import { defineCheck, fail, result, type Finding } from '../framework';
import { deployWorkflowFile, invariantsDoc, rel, repoRoot, workflowFile } from '../lib/paths';

/**
 * The release pipeline's safety properties, kept in the workflow (REL-006,
 * REL-007, STAB-001).
 *
 * The publish rules live in one script, which `ci.yml` calls. What this
 * check holds is that the workflow keeps calling that script instead of
 * re-implementing it inline, never moves a deployment tag on its own, and
 * keeps the gates that are easy to lose: a job that is deleted, renamed or made
 * quietly conditional stops running and nothing says so — the workflow just
 * goes green faster. Each assertion names a property rather than a YAML
 * layout, so the workflow can be reorganised freely and can only fail this by
 * ceasing to do the job.
 */

export interface PipelineReading {
  /** Every broken property, as a message. */
  problems: string[];
  /** The publish script the workflow calls, relative to the repository root. */
  script: string | null;
}

/** The workflow's jobs by name: the chunks under `jobs:` at two-space indent. */
export function jobsOf(workflow: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const chunk of workflow.split(/\n {2}(?=[a-z][a-z0-9-]*:\n)/)) {
    const name = /^\s*([a-z][a-z0-9-]*):/.exec(chunk)?.[1];
    if (name) out[name] = chunk;
  }
  return out;
}

/** The deploy rehearsal, where the workflow spells it. */
const DRILL = 'deploy/rehearsal/drill.sh';

/**
 * The shards `drill.sh` splits its cases into, in the order they first appear
 * in its `CASE_SHARDS=( … )` array (one `shard # case-id` per line).
 */
export function drillShards(drill: string): string[] {
  const block = /^CASE_SHARDS=\(\n([\s\S]*?)^\)/m.exec(drill)?.[1] ?? '';
  const out: string[] = [];
  for (const line of block.split('\n')) {
    const name = /^\s*([a-z][a-z0-9-]*)\s*(?:#.*)?$/.exec(line)?.[1];
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The names a job's matrix lists on its `shard: [a, b]` line. */
export function matrixShards(job: string): string[] {
  const list = /^\s+shard:\s*\[([^\]]*)\]/m.exec(job)?.[1] ?? '';
  return list
    .split(',')
    .map((n) => n.trim().replace(/^['"]|['"]$/g, ''))
    .filter((n) => n !== '');
}

/**
 * Files outside the code that a guard reads. A trigger filter that skips a
 * change to one of them lets it merge unchecked: `docs/invariants.md` cites
 * tests by name, and the `invariants` guard is what resolves them.
 */
export const GUARD_READ_FILES: readonly string[] = [rel(invariantsDoc)];

/** A GitHub Actions path glob as a regular expression over a repository path. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** The `paths` / `paths-ignore` filter of one `on:` event, as written. */
export function pathFilterOf(
  workflow: string,
  event: string,
): { kind: 'paths' | 'paths-ignore' | 'none'; patterns: string[] } | null {
  const lines = workflow.split('\n');
  const onAt = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (onAt < 0) {
    // `on: [push, pull_request]` or `on: push`: no filters at all.
    const inline = lines.find((line) => /^on:\s*\S/.test(line)) ?? '';
    return new RegExp(`\\b${event}\\b`).test(inline) ? { kind: 'none', patterns: [] } : null;
  }
  let at = -1;
  for (let i = onAt + 1; i < lines.length && !/^\S/.test(lines[i]!); i += 1) {
    if (new RegExp(`^  ${event}:`).test(lines[i]!)) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  for (let i = at + 1; i < lines.length && /^( {4}| *$| *#)/.test(lines[i]!); i += 1) {
    const key = /^ {4}(paths|paths-ignore):\s*$/.exec(lines[i]!)?.[1] as
      'paths' | 'paths-ignore' | undefined;
    if (!key) continue;
    const patterns: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const item = /^ {6}- ['"]?([^'"]+?)['"]?\s*(?:#.*)?$/.exec(lines[j]!);
      if (item) patterns.push(item[1]!);
      else if (!/^\s*(#.*)?$/.test(lines[j]!)) break;
    }
    return { kind: key, patterns };
  }
  return { kind: 'none', patterns: [] };
}

/**
 * Does a change to `file` alone start the workflow on `event`? `paths`: the
 * last pattern the file matches decides (`!` excludes). `paths-ignore`: the
 * run is skipped when the file matches (a `!` pattern re-includes).
 */
export function triggersOn(workflow: string, event: string, file: string): boolean {
  const filter = pathFilterOf(workflow, event);
  if (filter === null) return false;
  if (filter.kind === 'none') return true;
  let matched: boolean | null = null;
  for (const pattern of filter.patterns) {
    const negated = pattern.startsWith('!');
    if (globToRegExp(negated ? pattern.slice(1) : pattern).test(file)) matched = !negated;
  }
  return filter.kind === 'paths' ? matched === true : matched !== true;
}

/**
 * Read the workflow and the script it calls. `readScript` gets the path as the
 * workflow spells it and returns the file's text, or null when it is missing.
 */
export function readPipeline(
  workflow: string,
  readScript: (script: string) => string | null,
): PipelineReading {
  const problems: string[] = [];
  const need = (ok: boolean, message: string): void => {
    if (!ok) problems.push(message);
  };

  // Images are published through the one script, whose rules are proved
  // against a registry; the workflow carries no publish logic of its own.
  const script = /bash\s+(\S*publish-release\.sh)\s+tags\b/.exec(workflow)?.[1] ?? null;
  need(script !== null, 'publishes image tags without `publish-release.sh tags` (REL-006)');
  need(
    !/resolve_digest\(\)/.test(workflow) && !/imagetools create/.test(workflow),
    'carries publish helpers of its own instead of calling publish-release.sh (REL-006)',
  );
  need(
    !/publish-release\.sh promote/.test(workflow),
    'moves a deployment tag; automated publishing never promotes (REL-006)',
  );
  // The merge-gate jobs cancel in progress, which is right, so the publishing
  // job needs a repository-wide group of its own that never cancels.
  need(
    /group:\s*next-images-\$\{\{\s*github\.repository\s*\}\}/.test(workflow) &&
      /next-images[\s\S]{0,200}cancel-in-progress:\s*false/.test(workflow),
    'image publishing is not in a repository-wide `next-images-${{ github.repository }}` group with `cancel-in-progress: false` (REL-007)',
  );
  need(
    /deploy\/rehearsal\/drill\.sh/.test(workflow),
    'does not run the deploy rehearsal `deploy/rehearsal/drill.sh`',
  );

  if (script !== null) {
    const text = readScript(script);
    if (text === null) {
      problems.push(`calls ${script}, which does not exist (REL-006)`);
    } else {
      need(
        /refusing to guess/.test(text),
        `${script} no longer aborts on an unanswerable tag query ("refusing to guess", REL-004)`,
      );
      need(
        /refusing a conflicting release/.test(text),
        `${script} no longer aborts on a conflicting digest ("refusing a conflicting release", REL-003)`,
      );
    }
  }

  // A trigger filter written to skip prose must not skip what the guards read.
  // `merge_group` is the merge queue's event: without it the queue waits for
  // a `ci-gate` that never reports.
  for (const event of ['push', 'pull_request', 'merge_group']) {
    for (const file of GUARD_READ_FILES) {
      need(
        triggersOn(workflow, event, file),
        `a change to ${file} alone does not start the workflow on \`${event}\`, so the guard that reads it is skipped`,
      );
    }
  }

  // Only what is under `jobs:`; the `on:` events sit at the same indent.
  const jobsAt = workflow.search(/^jobs:\s*$/m);
  const jobs = jobsOf(jobsAt < 0 ? workflow : workflow.slice(jobsAt + 'jobs:'.length));

  // The merge queue requires `ci-gate` alone, so a gate job it does not need
  // stops gating. The jobs kept to one event (the soak, the images) are not
  // pull-request gates.
  const ciGate = jobs.gate ?? '';
  if (ciGate === '') {
    problems.push('has no `gate` job (`ci-gate`), the one check the merge queue requires');
  } else {
    need(/^ {4}if: always\(\)/m.test(ciGate), 'the `gate` job does not run under `if: always()`');
    const needs =
      /^ {4}needs:\s*\[([^\]]*)\]/m
        .exec(ciGate)?.[1]
        ?.split(',')
        .map((n) => n.trim()) ?? [];
    // `ci-gate` reads a skipped job as nothing to check, which is true only
    // of a skip `changes` decided.
    const skipsBy = /^ {4}if: needs\.changes\.outputs\.(code|full) == 'true'\s*$/m;
    for (const [name, job] of Object.entries(jobs)) {
      if (name === 'gate' || /^ {4}if:.*github\.event_name/m.test(job)) continue;
      need(
        needs.includes(name),
        `the \`gate\` job does not need \`${name}\`, so the merge queue lets it fail`,
      );
      if (name === 'changes') continue;
      need(
        skipsBy.test(job),
        `the \`${name}\` job is not skipped by \`changes\` alone (\`if: needs.changes.outputs.code|full == 'true'\`)`,
      );
    }
    need(
      skipsBy.exec(jobs.static ?? '')?.[1] === 'code',
      'the `static` job does not run on every pull request that touches code (`outputs.code`)',
    );
  }

  // The `changes` job is the pull request's path filter; it must not call a
  // file the guards read prose.
  const changes = jobs.changes ?? '';
  if (changes !== '') {
    for (const file of GUARD_READ_FILES) {
      need(
        changes.includes(`${file}) code=true`),
        `the \`changes\` job does not count ${file} as code, so the guard that reads it is skipped`,
      );
    }
  }

  // The guards run inside the merge gate, not in a job a required-check list
  // could forget to require.
  const gate = jobs.static ?? '';
  need(/pnpm guards/.test(gate), 'the `static` merge-gate job does not run `pnpm guards`');

  // The soak is nightly and on demand, never a pull-request gate. The
  // `schedule:` trigger is what makes "nightly" true: the `if:` alone would
  // make the job never run.
  const soak = jobs['concurrency-soak'] ?? '';
  if (soak === '') {
    problems.push('has no `concurrency-soak` job (STAB-001)');
  } else {
    need(
      /schedule:\s*\n\s*- cron:/.test(workflow),
      'has no `schedule:` cron, so the soak never runs (STAB-001)',
    );
    need(
      /github\.event_name == 'schedule'/.test(soak) &&
        /github\.event_name == 'workflow_dispatch'/.test(soak),
      'the soak does not run on `schedule` and `workflow_dispatch` only (STAB-001)',
    );
    need(
      /seq 1 50/.test(soak) && /--sequence\.shuffle/.test(soak),
      'the soak is not 50 shuffled rounds (STAB-001)',
    );
    // Stopping at the first failure throws the distribution away, and the
    // distribution is the thing worth knowing.
    need(
      /failed=\$\(\(failed \+ 1\)\)/.test(soak) && /test "\$failed" -eq 0/.test(soak),
      'the soak does not run every round and fail on the count (STAB-001)',
    );
    need(
      /if: always\(\)/.test(soak) && /soak-logs/.test(soak),
      'the soak does not upload `soak-logs` under `if: always()` (STAB-001)',
    );
  }

  // The rehearsal is split into shards that run on runners of their own. A case
  // that belongs to a shard the workflow does not list never runs, and the
  // job stays green: the one failure here that nothing else would report.
  const rehearsal = jobs.rehearsal ?? '';
  if (rehearsal === '') {
    problems.push('has no `rehearsal` job');
  } else {
    need(
      /drill\.sh\s+--shard\b/.test(rehearsal),
      'the `rehearsal` job does not run one shard of the drill (`drill.sh --shard`)',
    );
    const drill = readScript(DRILL);
    if (drill === null) {
      problems.push(`calls ${DRILL}, which does not exist`);
    } else {
      const have = drillShards(drill);
      const run = matrixShards(rehearsal);
      need(have.length > 0, `${DRILL} names no shards in \`CASE_SHARDS\``);
      for (const name of have) {
        need(
          run.includes(name),
          `the \`rehearsal\` matrix does not run the drill's \`${name}\` shard, so its cases never run`,
        );
      }
      for (const name of run) {
        need(
          have.includes(name),
          `the \`rehearsal\` matrix runs a \`${name}\` shard that ${DRILL} does not have`,
        );
      }
    }
  }

  // Playwright cannot run a browser it has not installed, and the failure is a
  // long job that fails in its last step.
  const e2e = jobs['e2e-admin'] ?? '';
  if (e2e === '') {
    problems.push('has no `e2e-admin` job');
  } else {
    const install = e2e.indexOf('playwright install --with-deps chromium');
    const run = e2e.indexOf('--filter @shop/e2e-admin e2e');
    need(install >= 0, 'the `e2e-admin` job does not install chromium');
    need(run >= 0, 'the `e2e-admin` job does not run `--filter @shop/e2e-admin e2e`');
    need(
      install < 0 || run < 0 || install < run,
      'the `e2e-admin` job runs the suite before it installs the browser',
    );
    need(/playwright-report/.test(e2e), 'the `e2e-admin` job does not upload `playwright-report`');
  }

  // Only the image job publishes.
  for (const [name, job] of Object.entries({
    static: gate,
    'concurrency-soak': soak,
    'e2e-admin': e2e,
  })) {
    need(
      !/publish-release\.sh/.test(job) && !/docker\s+push/.test(job),
      `the \`${name}\` job publishes; releases go through the image job alone`,
    );
  }

  return { problems, script };
}

/**
 * The deploy workflow, against the merge gate's: only it ships, every job that
 * runs `deploy/ship.sh` waits for a person in the `production` environment,
 * and it follows the gate by the gate's current name (a rename would leave it
 * never starting, and nothing would say so). The mini-program goes up to
 * WeChat only from a deploy job that needs `ship`, so the same approval
 * covers it and the host already runs the commit it was built from.
 */
/** A line that runs `deploy/ship.sh` to release (not `status`), as a command rather than in prose. */
const SHIPS = /^\s*(?:-\s+)?(?:run:\s*)?(?:bash\s+)?(?:\.\/)?deploy\/ship\.sh(?!\s+status)\b/m;
/** A line that runs the mini-program's upload for real (`--confirm`), not `--dry-run`. */
const UPLOADS = /^\s*(?:-\s+)?(?:run:\s*)?\S*node\s+\S*scripts\/upload\.mjs\b.*--confirm\b/m;

export function readDeploy(deploy: string, gate: string): string[] {
  const problems: string[] = [];
  if (SHIPS.test(gate)) {
    problems.push('the merge gate runs deploy/ship.sh; only deploy.yml ships');
  }
  if (UPLOADS.test(gate)) {
    problems.push('the merge gate uploads the mini-program; only deploy.yml does, after it ships');
  }
  const gateName = /^name:\s*(.+?)\s*$/m.exec(gate)?.[1];
  const follows = /^\s*workflows:\s*\[([^\]]*)\]/m
    .exec(deploy)?.[1]
    ?.split(',')
    .map((n) => n.trim().replace(/^['"]|['"]$/g, ''));
  if (!gateName || !follows?.includes(gateName)) {
    problems.push(
      `deploy.yml does not follow the merge gate by its name (\`workflows: [${gateName ?? '?'}]\`), so it never starts`,
    );
  }
  const jobsAt = deploy.search(/^jobs:\s*$/m);
  const jobs = jobsOf(jobsAt < 0 ? deploy : deploy.slice(jobsAt + 'jobs:'.length));
  for (const [name, job] of Object.entries(jobs)) {
    if (SHIPS.test(job) && !/^ {4}environment:\s*production\s*$/m.test(job)) {
      problems.push(
        `the deploy job \`${name}\` ships without \`environment: production\`, so nobody approves it`,
      );
    }
    if (
      UPLOADS.test(job) &&
      !/^ {4}needs:\s*(?:ship|\[(?:[^\]]*,\s*)?ship\s*(?:,[^\]]*)?\])\s*$/m.test(job)
    ) {
      problems.push(
        `the deploy job \`${name}\` uploads the mini-program without \`needs: ship\`, so it goes up unapproved or ahead of the server`,
      );
    }
  }
  return problems;
}

export const pipeline = defineCheck(
  'pipeline',
  'the workflow publishes through the tested script and keeps its gates',
  () => {
    const findings: Finding[] = [];
    const where = rel(workflowFile);
    if (!fs.existsSync(workflowFile)) {
      findings.push(fail(where, 'is missing — nothing builds or publishes the shop'));
      return result('pipeline', 'release pipeline', 'no workflow', findings);
    }
    const reading = readPipeline(fs.readFileSync(workflowFile, 'utf8'), (script) => {
      const file = path.resolve(repoRoot, script);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    });
    for (const problem of reading.problems) findings.push(fail(where, problem));
    const deployWhere = rel(deployWorkflowFile);
    if (!fs.existsSync(deployWorkflowFile)) {
      findings.push(fail(deployWhere, 'is missing — nothing ships what the merge gate built'));
    } else {
      for (const problem of readDeploy(
        fs.readFileSync(deployWorkflowFile, 'utf8'),
        fs.readFileSync(workflowFile, 'utf8'),
      )) {
        findings.push(fail(deployWhere, problem));
      }
    }
    return result(
      'pipeline',
      'release pipeline',
      `${where} read for its publish path (${reading.script ?? 'none'}) and its static, soak, admin e2e and rehearsal-shard gates; deploy.yml for its approval`,
      findings,
    );
  },
);
