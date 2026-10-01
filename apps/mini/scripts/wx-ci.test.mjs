// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { stampPath, treeState, writeStamp } from './gate-stamp.mjs';
import {
  apiOriginProblem,
  appRoot,
  committedBuildProblem,
  releaseProblem,
  shownCommand,
  uploadArgs,
  uploadDescription,
} from './wx-ci.mjs';

/**
 * The upload gate: a trial build is exactly a commit that master holds and CI passed, the way
 * deploy/ship.sh releases the server. `run` answers for git and gh here, so no test fetches,
 * asks GitHub, or reaches WeChat; no test reads the upload key.
 */

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/**
 * A fake `run`: `answers` maps `command arg0 arg1` prefixes to replies; anything else fails the
 * test, so a check that asks something new is noticed. Every call is recorded.
 */
function fakeRun(answers) {
  const calls = [];
  const run = (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
    if (!key) throw new Error(`unexpected command: ${line}`);
    return { status: 0, stdout: '', stderr: '', ...answers[key] };
  };
  return { run, calls };
}

const clean = { 'git rev-parse HEAD': { stdout: `${HEAD}\n` }, 'git status': { stdout: '' } };
const released = (ci) => ({
  'git fetch': {},
  'git merge-base': {},
  'gh run list': { stdout: ci },
});

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-ci-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function builtFrom(stamp) {
  const dist = fs.mkdtempSync(path.join(scratch, 'weapp-'));
  if (stamp) fs.writeFileSync(stampPath(dist), JSON.stringify({ sha256: 'x', ...stamp }));
  return dist;
}

describe('committedBuildProblem', () => {
  it('passes a clean tree whose build size-report stamped from HEAD', () => {
    const dist = builtFrom({ commit: HEAD, dirty: false });
    expect(committedBuildProblem(dist, fakeRun(clean).run)).toBeNull();
  });

  it('refuses a working tree with changes, naming them', () => {
    const { run } = fakeRun({ ...clean, 'git status': { stdout: ' M src/app.tsx\n?? x.ts\n' } });
    expect(committedBuildProblem(builtFrom({ commit: HEAD }), run)).toMatch(
      /working tree has changes \(M src\/app\.tsx; \?\? x\.ts\)/,
    );
  });

  it('refuses a build from another commit, a dirty tree, or with no stamp', () => {
    const { run } = fakeRun(clean);
    expect(committedBuildProblem(builtFrom({ commit: OTHER, dirty: false }), run)).toBe(
      `dist/weapp was built from ${OTHER}, HEAD is ${HEAD}; rebuild`,
    );
    // A stamp from before stamps said which commit.
    expect(committedBuildProblem(builtFrom({}), run)).toMatch(/an unknown commit/);
    expect(committedBuildProblem(builtFrom({ commit: HEAD, dirty: true }), run)).toMatch(
      /uncommitted changes/,
    );
    expect(committedBuildProblem(builtFrom(null), run)).toMatch(/size-report has not passed/);
  });

  it('refuses outside a git checkout', () => {
    const { run } = fakeRun({ 'git rev-parse': { status: 128 }, 'git status': { status: 128 } });
    expect(committedBuildProblem(builtFrom({ commit: HEAD }), run)).toBe('not in a git checkout');
  });
});

describe('apiOriginProblem', () => {
  it('passes a build that calls an https origin', () => {
    expect(apiOriginProblem(builtFrom({ apiOrigin: 'https://x-zoo.vip' }))).toBeNull();
  });

  it('reads the origin size-report stamped the build with', () => {
    const dist = builtFrom(null);
    writeStamp(dist, { commit: HEAD, changes: [] }, 'https://x-zoo.vip');
    expect(apiOriginProblem(dist)).toBeNull();
    writeStamp(dist, { commit: HEAD, changes: [] }, '');
    expect(apiOriginProblem(dist)).toMatch(/built without an API origin/);
  });

  it('refuses a build with no origin, plain http, a path, or no stamp', () => {
    // A stamp from before stamps said which origin, or `build:weapp` with none in its environment.
    expect(apiOriginProblem(builtFrom({}))).toMatch(/built without an API origin/);
    expect(apiOriginProblem(builtFrom({ apiOrigin: '' }))).toMatch(/built without an API origin/);
    expect(apiOriginProblem(builtFrom({ apiOrigin: 'http://192.168.1.5:3000' }))).toMatch(
      /calls an https origin/,
    );
    expect(apiOriginProblem(builtFrom({ apiOrigin: 'https://x-zoo.vip/api' }))).toMatch(
      /calls an https origin/,
    );
    expect(apiOriginProblem(builtFrom({ apiOrigin: 'x-zoo.vip' }))).toMatch(/not a URL/);
    expect(apiOriginProblem(builtFrom(null))).toMatch(/size-report has not passed/);
  });
});

describe('releaseProblem (as deploy/ship.sh)', () => {
  it('passes a commit on origin/master whose CI push run succeeded', () => {
    const { run, calls } = fakeRun(released('completed failure\ncompleted success\n'));
    expect(releaseProblem(HEAD, run)).toBeNull();
    expect(calls).toEqual([
      'git fetch --quiet origin master',
      `git merge-base --is-ancestor ${HEAD} FETCH_HEAD`,
      expect.stringMatching(
        new RegExp(`^gh run list --workflow ci\\.yml --commit ${HEAD} --event push `),
      ),
    ]);
  });

  it('refuses a commit master does not hold, before asking GitHub', () => {
    const { run, calls } = fakeRun({
      ...released('completed success'),
      'git merge-base': { status: 1 },
    });
    expect(releaseProblem(HEAD, run)).toMatch(/is not on origin\/master/);
    expect(calls.some((call) => call.startsWith('gh'))).toBe(false);
  });

  it('refuses when origin or GitHub cannot be asked', () => {
    expect(releaseProblem(HEAD, fakeRun({ 'git fetch': { status: 128 } }).run)).toMatch(
      /could not fetch master/,
    );
    const gh = fakeRun({ ...released(''), 'gh run list': { status: 4 } });
    expect(releaseProblem(HEAD, gh.run)).toMatch(/could not ask GitHub/);
  });

  it('refuses a commit CI has not passed', () => {
    expect(releaseProblem(HEAD, fakeRun(released('')).run)).toMatch(/CI has no push run.*docs/);
    expect(releaseProblem(HEAD, fakeRun(released('in_progress \n')).run)).toMatch(/still running/);
    expect(
      releaseProblem(HEAD, fakeRun(released('completed failure\ncompleted cancelled\n')).run),
    ).toBe(`CI did not pass for ${HEAD}: completed failure, completed cancelled`);
  });
});

describe('what goes to miniprogram-ci', () => {
  const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;

  it('uploads as 1.0.0, the version the operator keeps', () => {
    expect(version).toBe('1.0.0');
    const args = uploadArgs({
      dist: '/d',
      key: '/k',
      appid: 'wx0123456789abcdef',
      version,
      desc: 'd',
      robot: '1',
    });
    expect(args[args.indexOf('--uv') + 1]).toBe('1.0.0');
  });

  it('describes the upload in Shanghai time, with the commit', () => {
    expect(uploadDescription('1.0.0', HEAD, new Date('2026-09-25T16:30:00Z'))).toBe(
      '1.0.0 aaaaaaaaa 2026-09-26 00:30',
    );
  });

  it('prints the command without the key path', () => {
    const shown = shownCommand(
      uploadArgs({
        dist: '/d',
        key: '/secret/private.wx.key',
        appid: 'wx0123456789abcdef',
        version,
        desc: 'a b',
        robot: '1',
      }),
      '/secret/private.wx.key',
    );
    expect(shown).not.toContain('secret');
    expect(shown).toContain('"--pkp" <key>');
    expect(shown).toContain('"--ud" "a b"');
  });
});

describe('treeState', () => {
  it('reads HEAD and the changes; a failed status counts as changed', () => {
    expect(treeState(fakeRun(clean).run)).toEqual({ commit: HEAD, changes: [] });
    const failed = fakeRun({ 'git rev-parse HEAD': { stdout: HEAD }, 'git status': { status: 1 } });
    expect(treeState(failed.run).changes).toEqual(['?']);
  });
});
