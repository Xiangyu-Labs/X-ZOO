import { describe, expect, it } from 'vitest';
import {
  drillShards,
  globToRegExp,
  jobsOf,
  matrixShards,
  readDeploy,
  readPipeline,
  triggersOn,
} from './pipeline';

/**
 * The `pipeline` check's reading of a workflow, against a small one that keeps
 * every property. Each case breaks one property and expects exactly that
 * complaint, so a regex that stops matching shows up as a missing complaint.
 */

const WORKFLOW = `name: shop
on:
  push:
    branches: [master]
  pull_request:
  merge_group:
  schedule:
    - cron: "0 18 * * *"
jobs:
  changes:
    steps:
      - run: |
          case "$file" in
            docs/invariants.md) code=true ;;
            docs/* | *.md) ;;
            *) code=true ;;
          esac
  static:
    runs-on: ubuntu-latest
    needs: changes
    if: needs.changes.outputs.code == 'true'
    steps:
      - run: corepack pnpm guards
  e2e-admin:
    runs-on: ubuntu-latest
    needs: changes
    if: needs.changes.outputs.full == 'true'
    steps:
      - run: corepack pnpm exec playwright install --with-deps chromium
      - run: corepack pnpm --filter @shop/e2e-admin e2e
      - uses: actions/upload-artifact@v4
        with:
          name: playwright-report
  concurrency-soak:
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    steps:
      - run: |
          failed=0
          for round in $(seq 1 50); do
            pnpm test:int -- --sequence.shuffle || failed=$((failed + 1))
          done
          test "$failed" -eq 0
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: soak-logs
  images:
    if: github.event_name == 'push'
    concurrency:
      group: next-images-\${{ github.repository }}
      cancel-in-progress: false
    steps:
      - run: digest="$(bash release/publish-release.sh tags "$image" "$GITHUB_SHA")"
  rehearsal:
    needs: changes
    if: needs.changes.outputs.full == 'true'
    strategy:
      matrix:
        shard: [release, unhealthy]
    steps:
      - run: deploy/rehearsal/drill.sh --shard "$SHARD" --no-build
      - run: deploy/rehearsal/drill.sh --list --shard "$SHARD"
  gate:
    needs: [changes, static, e2e-admin, rehearsal]
    if: always()
    steps:
      - run: jq -e . <<<"$NEEDS"
`;

const SCRIPT = 'echo "refusing to guess"\necho "refusing a conflicting release"\n';

const DRILL = `CASE_IDS=(a b c)
CASE_SHARDS=(
  release # static/one
  release # upgrade/two
  unhealthy # upgrade/three
)
`;

const read = (workflow: string, script: string | null = SCRIPT, drill: string | null = DRILL) =>
  readPipeline(workflow, (path) =>
    path === 'release/publish-release.sh'
      ? script
      : path === 'deploy/rehearsal/drill.sh'
        ? drill
        : null,
  );

describe('readPipeline', () => {
  it('passes a workflow that keeps every property, and finds the script it calls', () => {
    expect(read(WORKFLOW)).toEqual({ problems: [], script: 'release/publish-release.sh' });
  });

  it('splits the jobs by name', () => {
    expect(Object.keys(jobsOf(WORKFLOW))).toEqual(
      expect.arrayContaining(['static', 'e2e-admin', 'concurrency-soak', 'images', 'rehearsal']),
    );
  });

  it('REL-006 — fails when tags are not published through the script', () => {
    const { problems } = read(
      WORKFLOW.replace('bash release/publish-release.sh tags', 'docker push'),
    );
    expect(problems.join('\n')).toMatch(/without `publish-release\.sh tags`/);
  });

  it('REL-006 — fails when the workflow carries publish helpers of its own', () => {
    const { problems } = read(`${WORKFLOW}      - run: docker buildx imagetools create x\n`);
    expect(problems).toEqual([
      'carries publish helpers of its own instead of calling publish-release.sh (REL-006)',
    ]);
  });

  it('REL-006 — fails when the workflow promotes', () => {
    const { problems } = read(
      `${WORKFLOW}      - run: bash release/publish-release.sh promote x\n`,
    );
    expect(problems.join('\n')).toMatch(/automated publishing never promotes/);
  });

  it('REL-006 — fails when the script the workflow calls is missing', () => {
    expect(read(WORKFLOW, null).problems).toEqual([
      'calls release/publish-release.sh, which does not exist (REL-006)',
    ]);
  });

  it('REL-003 and REL-004 — fails when the script stops refusing', () => {
    expect(read(WORKFLOW, 'echo ok\n').problems).toHaveLength(2);
  });

  it('REL-007 — fails when the image job may be cancelled mid-publish', () => {
    const { problems } = read(
      WORKFLOW.replace('cancel-in-progress: false', 'cancel-in-progress: true'),
    );
    expect(problems.join('\n')).toMatch(/REL-007/);
  });

  it('fails when the merge gate stops running the guards', () => {
    const { problems } = read(WORKFLOW.replace('corepack pnpm guards', 'corepack pnpm lint'));
    expect(problems).toEqual(['the `static` merge-gate job does not run `pnpm guards`']);
  });

  it('STAB-001 — fails when the soak loses its schedule, its rounds or its logs', () => {
    expect(read(WORKFLOW.replace('  schedule:\n    - cron: "0 18 * * *"\n', '')).problems).toEqual([
      'has no `schedule:` cron, so the soak never runs (STAB-001)',
    ]);
    expect(read(WORKFLOW.replace('seq 1 50', 'seq 1 5')).problems).toEqual([
      'the soak is not 50 shuffled rounds (STAB-001)',
    ]);
    expect(read(WORKFLOW.replace('- if: always()', '- if: failure()')).problems).toEqual([
      'the soak does not upload `soak-logs` under `if: always()` (STAB-001)',
    ]);
  });

  it('names the shards the drill has and the matrix runs', () => {
    expect(drillShards(DRILL)).toEqual(['release', 'unhealthy']);
    expect(matrixShards('    strategy:\n      matrix:\n        shard: [\'a\', "b", c]\n')).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(matrixShards('    steps: []\n')).toEqual([]);
  });

  it('fails when the rehearsal matrix leaves a drill shard out, or runs one it lacks', () => {
    expect(
      read(WORKFLOW.replace('shard: [release, unhealthy]', 'shard: [release]')).problems,
    ).toEqual([
      "the `rehearsal` matrix does not run the drill's `unhealthy` shard, so its cases never run",
    ]);
    expect(
      read(WORKFLOW.replace('shard: [release, unhealthy]', 'shard: [release, unhealthy, extra]'))
        .problems,
    ).toEqual([
      'the `rehearsal` matrix runs a `extra` shard that deploy/rehearsal/drill.sh does not have',
    ]);
    expect(read(WORKFLOW, SCRIPT, DRILL.replace('unhealthy #', 'later #')).problems).toEqual([
      "the `rehearsal` matrix does not run the drill's `later` shard, so its cases never run",
      'the `rehearsal` matrix runs a `unhealthy` shard that deploy/rehearsal/drill.sh does not have',
    ]);
  });

  it('fails when the rehearsal runs the whole drill on every runner, or the drill is gone', () => {
    expect(
      read(WORKFLOW.replace('drill.sh --shard "$SHARD" --no-build', 'drill.sh --no-build'))
        .problems,
    ).toEqual(['the `rehearsal` job does not run one shard of the drill (`drill.sh --shard`)']);
    expect(read(WORKFLOW, SCRIPT, null).problems).toEqual([
      'calls deploy/rehearsal/drill.sh, which does not exist',
    ]);
  });

  it('fails when the admin e2e job runs the suite before installing the browser', () => {
    const swapped = WORKFLOW.replace(
      '      - run: corepack pnpm exec playwright install --with-deps chromium\n      - run: corepack pnpm --filter @shop/e2e-admin e2e\n',
      '      - run: corepack pnpm --filter @shop/e2e-admin e2e\n      - run: corepack pnpm exec playwright install --with-deps chromium\n',
    );
    expect(read(swapped).problems).toEqual([
      'the `e2e-admin` job runs the suite before it installs the browser',
    ]);
  });

  it('fails when a gate job publishes', () => {
    const { problems } = read(
      WORKFLOW.replace(
        '      - run: corepack pnpm guards\n',
        '      - run: corepack pnpm guards\n      - run: docker push x\n',
      ),
    );
    expect(problems).toEqual([
      'the `static` job publishes; releases go through the image job alone',
    ]);
  });

  it('REL-008 — fails when the trigger filter skips a change to docs/invariants.md', () => {
    const ignoring = WORKFLOW.replace(
      '  push:\n    branches: [master]\n  pull_request:\n',
      "  push:\n    branches: [master]\n    paths-ignore:\n      - 'docs/**'\n      - '**/*.md'\n  pull_request:\n    paths-ignore:\n      - 'docs/**'\n      - '**/*.md'\n",
    );
    expect(read(ignoring).problems).toEqual([
      'a change to docs/invariants.md alone does not start the workflow on `push`, so the guard that reads it is skipped',
      'a change to docs/invariants.md alone does not start the workflow on `pull_request`, so the guard that reads it is skipped',
    ]);
  });

  it('REL-008 — passes a filter that skips prose but re-includes what the guards read', () => {
    const filter =
      "    paths:\n      - '**'\n      - '!docs/**'\n      - '!**/*.md'\n      - 'docs/invariants.md'\n";
    const filtered = WORKFLOW.replace(
      '  push:\n    branches: [master]\n  pull_request:\n',
      `  push:\n    branches: [master]\n${filter}  pull_request:\n${filter}`,
    );
    expect(read(filtered).problems).toEqual([]);
    expect(triggersOn(filtered, 'push', 'docs/deploy.md')).toBe(false);
    expect(triggersOn(filtered, 'push', 'apps/web/README.md')).toBe(false);
    expect(triggersOn(filtered, 'pull_request', 'apps/web/src/server/handle.ts')).toBe(true);
    expect(triggersOn(filtered, 'push', '.github/workflows/ci.yml')).toBe(true);
  });

  it('fails when the merge queue would wait on a workflow it never starts', () => {
    expect(read(WORKFLOW.replace('  merge_group:\n', '')).problems).toEqual([
      'a change to docs/invariants.md alone does not start the workflow on `merge_group`, so the guard that reads it is skipped',
    ]);
  });

  it('fails when `ci-gate` does not need a gate job, or is skipped with it', () => {
    const missing = WORKFLOW.replace(
      'needs: [changes, static, e2e-admin, rehearsal]',
      'needs: [changes, static, rehearsal]',
    );
    expect(read(missing).problems).toEqual([
      'the `gate` job does not need `e2e-admin`, so the merge queue lets it fail',
    ]);
    expect(read(WORKFLOW.replace('    if: always()\n', '')).problems).toEqual([
      'the `gate` job does not run under `if: always()`',
    ]);
  });

  it('fails when a gate job is skipped by anything but `changes`', () => {
    const always = WORKFLOW.replace(
      "    needs: changes\n    if: needs.changes.outputs.full == 'true'\n    strategy:",
      "    needs: changes\n    if: github.ref == 'refs/heads/master'\n    strategy:",
    );
    expect(read(always).problems).toEqual([
      "the `rehearsal` job is not skipped by `changes` alone (`if: needs.changes.outputs.code|full == 'true'`)",
    ]);
    const heavyStatic = WORKFLOW.replace(
      "    if: needs.changes.outputs.code == 'true'",
      "    if: needs.changes.outputs.full == 'true'",
    );
    expect(read(heavyStatic).problems).toEqual([
      'the `static` job does not run on every pull request that touches code (`outputs.code`)',
    ]);
  });

  it('fails when the `changes` job calls docs/invariants.md prose', () => {
    const prose = WORKFLOW.replace('            docs/invariants.md) code=true ;;\n', '');
    expect(read(prose).problems).toEqual([
      'the `changes` job does not count docs/invariants.md as code, so the guard that reads it is skipped',
    ]);
  });

  it('reads GitHub path globs', () => {
    expect(globToRegExp('**/*.md').test('README.md')).toBe(true);
    expect(globToRegExp('**/*.md').test('a/b/c.md')).toBe(true);
    expect(globToRegExp('docs/**').test('docs/mini/x.md')).toBe(true);
    expect(globToRegExp('docs/*').test('docs/mini/x.md')).toBe(false);
    expect(globToRegExp('docs/invariants.md').test('docs/invariantsXmd')).toBe(false);
  });
});

describe('readDeploy', () => {
  const GATE =
    'name: Merge gate & images\non:\n  push:\njobs:\n  static:\n    steps:\n      - run: pnpm guards\n';
  const DEPLOY = `name: Deploy
on:
  workflow_run:
    workflows: [Merge gate & images]
    types: [completed]
jobs:
  ship:
    environment: production
    steps:
      - run: deploy/ship.sh "$SHA"
      - if: failure()
        run: deploy/ship.sh status || true
  mini:
    needs: ship
    environment: mini-trial
    steps:
      - run: node apps/mini/scripts/upload.mjs --dry-run
      - run: |
          node apps/mini/scripts/upload.mjs --confirm --robot 2
`;

  it('passes a deploy that follows the gate and waits for approval', () => {
    expect(readDeploy(DEPLOY, GATE)).toEqual([]);
  });

  it('fails when the job that ships needs no approval', () => {
    expect(readDeploy(DEPLOY.replace('    environment: production\n', ''), GATE)).toEqual([
      'the deploy job `ship` ships without `environment: production`, so nobody approves it',
    ]);
  });

  it('fails when the gate was renamed and the deploy still follows the old name', () => {
    expect(readDeploy(DEPLOY, GATE.replace('Merge gate & images', 'ci'))).toEqual([
      'deploy.yml does not follow the merge gate by its name (`workflows: [ci]`), so it never starts',
    ]);
  });

  it('fails when the merge gate ships by itself', () => {
    expect(readDeploy(DEPLOY, `${GATE}      - run: deploy/ship.sh "$GITHUB_SHA"\n`)).toEqual([
      'the merge gate runs deploy/ship.sh; only deploy.yml ships',
    ]);
  });

  it('fails when the mini-program goes up without waiting for the ship', () => {
    expect(readDeploy(DEPLOY.replace('    needs: ship\n', ''), GATE)).toEqual([
      'the deploy job `mini` uploads the mini-program without `needs: ship`, so it goes up unapproved or ahead of the server',
    ]);
    expect(readDeploy(DEPLOY.replace('needs: ship', 'needs: [build, ship]'), GATE)).toEqual([]);
  });

  it('fails when the merge gate uploads the mini-program', () => {
    expect(
      readDeploy(DEPLOY, `${GATE}      - run: node apps/mini/scripts/upload.mjs --confirm\n`),
    ).toEqual(['the merge gate uploads the mini-program; only deploy.yml does, after it ships']);
    expect(
      readDeploy(DEPLOY, `${GATE}      - run: node apps/mini/scripts/upload.mjs --dry-run\n`),
    ).toEqual([]);
  });
});
