/**
 * The record that `size-report.mjs` passed on exactly the files now in a build folder
 * (`dist/weapp` → `dist/weapp.gate.json`, beside it so it is never uploaded).
 *
 * A build reaches WeChat only through `preview.mjs` or `upload.mjs`, and both refuse a folder
 * whose files are not the ones the gate passed: a `taro build` or `dev:weapp` run after the gate
 * (or instead of it) changes them. That is how `> *` reached a trial build once while the gate
 * already forbade it (ca110d376).
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

/**
 * Runs a command in the repository and hands back what the gates read of it. The gates take it
 * as a parameter, so a test can answer `git` and `gh` without either (scripts/wx-ci.test.mjs).
 */
export function runCommand(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * The commit HEAD names (`null` outside a git checkout) and what the working tree has that git
 * does not ignore (`dist/`, `.env.*.local` and the upload key are ignored).
 */
export function treeState(run = runCommand) {
  const head = run('git', ['rev-parse', 'HEAD']);
  const status = run('git', ['status', '--porcelain']);
  const changes =
    status.status === 0 ? status.stdout.split('\n').filter((line) => line.trim() !== '') : ['?'];
  return { commit: head.status === 0 ? head.stdout.trim() : null, changes };
}

/** DevTools' own files: not part of the uploaded package. */
export const NOT_UPLOADED = new Set(['project.config.json', 'project.private.config.json']);

export function stampPath(dist) {
  return `${dist.replace(/[\\/]+$/, '')}.gate.json`;
}

/** One hash over every uploaded file's path and bytes, in path order. */
export function fingerprint(dist) {
  const hash = crypto.createHash('sha256');
  const files = fs
    .readdirSync(dist, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(dist, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    )
    .filter((rel) => !NOT_UPLOADED.has(rel))
    .sort();
  for (const rel of files) {
    hash.update(`${rel}\0`);
    hash.update(fs.readFileSync(path.join(dist, rel)));
    hash.update('\0');
  }
  return { files: files.length, sha256: hash.digest('hex') };
}

/** `2026-09-25 23:30`, Asia/Shanghai: how an instant is shown to a person (AGENTS.md 2). */
export function shanghaiMinute(instant) {
  const parts = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant))) {
    parts[type] = value;
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function clearStamp(dist) {
  fs.rmSync(stampPath(dist), { force: true });
}

/**
 * `commit` and `dirty` say what the build was made from, so an upload can refuse a build that is
 * not exactly a commit (wx-ci.mjs `committedBuildProblem`). `apiOrigin` is the API the build
 * talks to, as the build's own environment gave it to config/index.ts (`''` when none did), so
 * an upload can refuse a package that would call nowhere or plain http (`apiOriginProblem`).
 */
export function writeStamp(
  dist,
  tree = treeState(),
  apiOrigin = process.env.TARO_APP_API_ORIGIN ?? '',
) {
  const stamp = {
    passedAt: new Date().toISOString(),
    commit: tree.commit,
    dirty: tree.changes.length > 0,
    apiOrigin,
    ...fingerprint(dist),
  };
  fs.writeFileSync(stampPath(dist), `${JSON.stringify(stamp, null, 2)}\n`);
}

export function readStamp(dist) {
  const file = stampPath(dist);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/** Why `dist` may not be uploaded, or `null` when the gate passed on these very files. */
export function gateProblem(dist) {
  const file = stampPath(dist);
  if (!fs.existsSync(file)) {
    return 'size-report has not passed on this build; build it with `pnpm build:weapp` or scripts/device-build.mjs';
  }
  const stamp = JSON.parse(fs.readFileSync(file, 'utf8'));
  const now = fingerprint(dist);
  if (stamp.sha256 !== now.sha256) {
    return `the files changed after size-report passed (${shanghaiMinute(stamp.passedAt)}); rebuild with \`pnpm build:weapp\` or scripts/device-build.mjs`;
  }
  return null;
}
