#!/usr/bin/env node
/**
 * A 真机预览 QR code for `dist/weapp` without 微信开发者工具, through miniprogram-ci's CLI
 * (docs/mini/device-check.md, 「可选：用 miniprogram-ci 出预览码」):
 *
 *   WX_MINI_UPLOAD_KEY_PATH=~/secrets/private.wx4f4b772125e155ed.key \
 *     node scripts/preview.mjs --confirm [--robot 1] [--qr-file /tmp/preview.jpg]
 *
 * **Every run uploads the package to WeChat's servers.** Run it only when the user has approved
 * this one preview; `--confirm` is never defaulted and never read from the environment. A trial
 * build (体验版) goes up through `upload.mjs` instead.
 *
 * It refuses to run unless:
 *
 * - `WX_MINI_UPLOAD_KEY_PATH` names an existing file outside the repository, or inside it where
 *   git ignores it (the upload key from 公众平台 → 开发管理 → 开发设置 → 小程序代码上传; it is a
 *   credential, never committed, and the `mini` guard fails on a tracked `private.*.key`);
 * - `dist/weapp` exists, its AppID (`project.config.json`) is a real one, not touristappid, and
 *   size-report passed on exactly its files (`dist/weapp.gate.json`, gate-stamp.mjs);
 * - the working tree is clean and that build was made from HEAD on a clean tree (a preview may
 *   be of a branch, so unlike `upload.mjs` it asks no CI);
 * - a `miniprogram-ci` executable is on `PATH` or named by `MINIPROGRAM_CI_BIN`. It is not a
 *   dependency of this repository; install it yourself, outside it (`npm i -g miniprogram-ci`).
 *
 * The machine's public IP must be in the key's IP whitelist, or WeChat answers with an
 * "invalid ip" error. The CLI flags are miniprogram-ci's documented `preview` ones (`--pp`,
 * `--pkp`, `--appid`, `--uv`, `-r`, `--qrcode-format`, `--qrcode-output-dest`); check them
 * against `miniprogram-ci preview --help` of the version you install.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  appRoot,
  committedBuildProblem,
  gatedBuild,
  miniprogramCi,
  refuser,
  uploadKey,
} from './wx-ci.mjs';

const { values: args } = parseArgs({
  options: {
    confirm: { type: 'boolean', default: false },
    robot: { type: 'string', default: '1' },
    'qr-file': { type: 'string' },
  },
});

const refuse = refuser('preview');
const realKey = uploadKey(refuse);
const { dist, appid } = gatedBuild(refuse);
if (!/^([1-9]|[12][0-9]|30)$/.test(args.robot)) refuse('--robot is 1–30');
// A preview may be of a branch (it is how a change is checked on a phone before it merges), so
// it asks no CI; but it is always a commit, so what a phone showed can be found again.
const built = committedBuildProblem(dist);
if (built) refuse(built);

// --- the user's say-so, every time --------------------------------------------------------
if (!args.confirm) {
  refuse(
    `this would upload dist/weapp (AppID ${appid}) to WeChat's servers for a preview QR code. ` +
      'Re-run with --confirm only after the user has approved this preview.',
  );
}

const bin = miniprogramCi(refuse);

const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
const qr = args['qr-file']
  ? ['--qrcode-format', 'image', '--qrcode-output-dest', path.resolve(args['qr-file'])]
  : ['--qrcode-format', 'terminal'];

console.log(`preview: uploading dist/weapp as AppID ${appid}, robot ${args.robot} …`);
const run = spawnSync(
  bin,
  [
    'preview',
    '--pp',
    dist,
    '--pkp',
    realKey,
    '--appid',
    appid,
    '--uv',
    version,
    '-r',
    args.robot,
    ...qr,
  ],
  { stdio: 'inherit' },
);
if (run.status !== 0) refuse(`miniprogram-ci exited ${run.status ?? run.signal}`);
