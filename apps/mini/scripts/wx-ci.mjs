/**
 * What `preview.mjs` and `upload.mjs` check before anything goes to WeChat's servers
 * (docs/mini/device-check.md). Each `refuse`s with the reason and exit 1.
 *
 * The functions that ask git and GitHub take `run` (gate-stamp.mjs `runCommand`) so the tests
 * answer for them: nothing here is exercised against WeChat, and the tests call neither git's
 * remote nor gh (scripts/wx-ci.test.mjs).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gateProblem, readStamp, runCommand, shanghaiMinute, treeState } from './gate-stamp.mjs';

export const appRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(appRoot, '../..');

export function refuser(name) {
  return (message) => {
    console.error(`${name}: ${message}`);
    process.exit(1);
  };
}

/**
 * The upload key named by `WX_MINI_UPLOAD_KEY_PATH` (公众平台 → 开发管理 → 开发设置 → 小程序代码上传).
 * It is a credential: outside the repository, or inside it only where git ignores it
 * (`private.*.key` in .gitignore), so it can never be committed.
 */
export function uploadKey(refuse) {
  const keyEnv = process.env.WX_MINI_UPLOAD_KEY_PATH;
  if (!keyEnv) {
    refuse('WX_MINI_UPLOAD_KEY_PATH is not set. Point it at the upload key (never committed).');
  }
  const keyPath = path.resolve(keyEnv.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
  if (!fs.existsSync(keyPath) || !fs.statSync(keyPath).isFile()) {
    refuse(`WX_MINI_UPLOAD_KEY_PATH: ${keyPath} is not a file`);
  }
  const realKey = fs.realpathSync(keyPath);
  const fromRepo = path.relative(fs.realpathSync(repoRoot), realKey);
  if (!fromRepo.startsWith('..') && !path.isAbsolute(fromRepo)) {
    const ignored = spawnSync('git', ['check-ignore', '-q', realKey], { cwd: repoRoot });
    if (ignored.status !== 0) {
      refuse(
        `${realKey} is inside the repository and git does not ignore it; move it outside (and rotate it if it was ever committed)`,
      );
    }
  }
  return realKey;
}

/** `dist/weapp` with a real AppID, and passed by size-report on exactly these files. */
export function gatedBuild(refuse) {
  const dist = path.join(appRoot, 'dist/weapp');
  const projectFile = path.join(dist, 'project.config.json');
  if (!fs.existsSync(projectFile)) {
    refuse('dist/weapp not found; run scripts/device-build.mjs first');
  }
  const { appid } = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  if (typeof appid !== 'string' || !/^wx[0-9a-f]{16}$/.test(appid)) {
    refuse(
      `dist/weapp is built for ${String(appid)}; WeChat needs a real AppID (device-build --appid)`,
    );
  }
  const problem = gateProblem(dist);
  if (problem) refuse(`dist/weapp: ${problem}`);
  return { dist, appid };
}

/** The miniprogram-ci CLI, which this repository does not install. */
export function miniprogramCi(refuse) {
  if (process.env.MINIPROGRAM_CI_BIN) return process.env.MINIPROGRAM_CI_BIN;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'miniprogram-ci');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  refuse('miniprogram-ci is not installed; `npm i -g miniprogram-ci` (outside this repository)');
}

/**
 * Why the build in `dist` is not exactly the commit HEAD names, or `null`: the working tree has
 * nothing git does not ignore, and size-report stamped this build from HEAD on a clean tree. A
 * package on a phone can then always be traced to a commit.
 */
export function committedBuildProblem(dist, run = runCommand) {
  const tree = treeState(run);
  if (!tree.commit) return 'not in a git checkout';
  if (tree.changes.length > 0) {
    const shown = tree.changes.slice(0, 5).map((line) => line.trim());
    return `the working tree has changes (${shown.join('; ')}${tree.changes.length > 5 ? '; …' : ''}); commit them, rebuild, then upload`;
  }
  const stamp = readStamp(dist);
  if (!stamp) return 'size-report has not passed on this build';
  if (stamp.commit !== tree.commit) {
    return `dist/weapp was built from ${stamp.commit ?? 'an unknown commit'}, HEAD is ${tree.commit}; rebuild`;
  }
  if (stamp.dirty) {
    return 'dist/weapp was built from a working tree with uncommitted changes; rebuild from the commit';
  }
  return null;
}

/**
 * Why the build in `dist` may not go to WeChat as a trial or release, or `null`: it must call
 * the API over https at a bare origin. An empty origin gives a package that loads nothing, and
 * WeChat accepts only https 服务器域名; `build:weapp` run without `TARO_APP_API_ORIGIN` in its
 * environment (a value in `.env.*.local` reaches Taro but not size-report) is refused here
 * rather than going up. deploy.yml checks its variable before building; this checks the build.
 */
export function apiOriginProblem(dist) {
  const stamp = readStamp(dist);
  if (!stamp) return 'size-report has not passed on this build';
  const raw = stamp.apiOrigin ?? '';
  const how =
    'rebuild with TARO_APP_API_ORIGIN=https://… in the environment, or scripts/device-build.mjs --origin https://…';
  if (!raw) return `dist/weapp was built without an API origin; ${how}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return `dist/weapp was built for ${raw}, which is not a URL; ${how}`;
  }
  if (url.protocol !== 'https:' || url.origin !== raw.replace(/\/$/, '')) {
    return `dist/weapp was built for ${raw}; a trial or release build calls an https origin; ${how}`;
  }
  return null;
}

/**
 * Why `commit` may not go up as a trial build, or `null`: the proof deploy/ship.sh asks of a
 * release. The commit is on origin/master (fetched now), and the `ci` workflow's push run for it
 * concluded `success`.
 */
export function releaseProblem(commit, run = runCommand) {
  if (run('git', ['fetch', '--quiet', 'origin', 'master']).status !== 0) {
    return 'could not fetch master from origin';
  }
  if (run('git', ['merge-base', '--is-ancestor', commit, 'FETCH_HEAD']).status !== 0) {
    return `${commit} is not on origin/master; only what master holds goes up as a trial build`;
  }
  const runs = run('gh', [
    'run',
    'list',
    '--workflow',
    'ci.yml',
    '--commit',
    commit,
    '--event',
    'push',
    '--limit',
    '20',
    '--json',
    'status,conclusion',
    '--jq',
    '.[] | .status + " " + .conclusion',
  ]);
  if (runs.status !== 0) return `could not ask GitHub about CI for ${commit} (is gh signed in?)`;
  const lines = runs.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.includes('completed success')) return null;
  if (lines.length === 0) {
    return `CI has no push run for ${commit}. The workflow ignores commits that change only docs/** or *.md: check out the newest commit CI built, rebuild, and upload that`;
  }
  if (lines.some((line) => !line.startsWith('completed '))) {
    return `CI is still running for ${commit}; upload it when it has passed`;
  }
  return `CI did not pass for ${commit}: ${[...new Set(lines)].join(', ')}`;
}

/** The version description 公众平台 shows: version, commit, and when (Asia/Shanghai). */
export function uploadDescription(version, commit, now = new Date()) {
  return `${version} ${commit.slice(0, 9)} ${shanghaiMinute(now)}`;
}

/** miniprogram-ci's `upload` arguments; `--uv` is package.json's version (1.0.0). */
export function uploadArgs({ dist, key, appid, version, desc, robot }) {
  return [
    'upload',
    '--pp',
    dist,
    '--pkp',
    key,
    '--appid',
    appid,
    '--uv',
    version,
    '--ud',
    desc,
    '-r',
    robot,
  ];
}

/** The command as `--dry-run` prints it: the key's path is not shown, only that one is passed. */
export function shownCommand(command, key) {
  return `miniprogram-ci ${command.map((arg) => (arg === key ? '<key>' : JSON.stringify(arg))).join(' ')}`;
}
