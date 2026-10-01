#!/usr/bin/env node
/**
 * Uploads `dist/weapp` as a development version (公众平台 → 版本管理 → 开发版本, from which the
 * operator picks 体验版 or submits for review), through miniprogram-ci's CLI:
 *
 *   WX_MINI_UPLOAD_KEY_PATH=private.wx4f4b772125e155ed.key \
 *     node apps/mini/scripts/upload.mjs --confirm [--desc "…"] [--robot 1]
 *   node apps/mini/scripts/upload.mjs --dry-run        # every check, nothing uploaded
 *
 * **Every run without `--dry-run` uploads the package to WeChat's servers.** Run it only when the
 * user has approved this one upload; `--confirm` is never defaulted and never read from the
 * environment. `.github/workflows/deploy.yml` passes it after the `production` approval, once the
 * host runs the same commit.
 *
 * The version is `package.json`'s (1.0.0); the operator manages versions in 公众平台, so this
 * script takes no version flag. It refuses to run unless:
 *
 * - the key, a real AppID, and a build that size-report passed on exactly as it is now — never a
 *   `dev:weapp` or bare `taro build` output, whose stylesheets and scripts nothing has checked
 *   (the same terms as `preview.mjs`, wx-ci.mjs);
 * - the build is exactly a commit: the working tree is clean and size-report stamped this build
 *   from HEAD on a clean tree;
 * - the build calls the API at an https origin (never an empty or plain-http one);
 * - that commit is released the way deploy/ship.sh releases one: it is on origin/master and the
 *   `ci` workflow's push run for it concluded `success` (asked with `gh`).
 *
 * `--dry-run` runs every check and prints the miniprogram-ci command (key path elided) instead
 * of running it; it needs neither `--confirm` nor miniprogram-ci.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  apiOriginProblem,
  appRoot,
  committedBuildProblem,
  gatedBuild,
  miniprogramCi,
  refuser,
  releaseProblem,
  shownCommand,
  uploadArgs,
  uploadDescription,
  uploadKey,
} from './wx-ci.mjs';
import { treeState } from './gate-stamp.mjs';

const { values: args } = parseArgs({
  options: {
    confirm: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    robot: { type: 'string', default: '1' },
    desc: { type: 'string' },
  },
});

const refuse = refuser('upload');
const realKey = uploadKey(refuse);
const { dist, appid } = gatedBuild(refuse);
if (!/^([1-9]|[12][0-9]|30)$/.test(args.robot)) refuse('--robot is 1–30');

const built = committedBuildProblem(dist);
if (built) refuse(built);
const origin = apiOriginProblem(dist);
if (origin) refuse(origin);
const commit = treeState().commit;
const released = releaseProblem(commit);
if (released) refuse(released);

const version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
const desc = args.desc ?? uploadDescription(version, commit);
const command = uploadArgs({ dist, key: realKey, appid, version, desc, robot: args.robot });

if (args['dry-run']) {
  console.log(`upload --dry-run: ${commit} passed every check; would run:`);
  console.log(`  ${shownCommand(command, realKey)}`);
  process.exit(0);
}
if (!args.confirm) {
  refuse(
    `this would upload dist/weapp (AppID ${appid}, commit ${commit}) to WeChat's servers as version ${version}. ` +
      'Re-run with --confirm only after the user has approved this upload.',
  );
}

const bin = miniprogramCi(refuse);
console.log(
  `upload: dist/weapp as AppID ${appid}, version ${version}, commit ${commit}, robot ${args.robot} …`,
);
const run = spawnSync(bin, command, { stdio: 'inherit' });
if (run.status !== 0) refuse(`miniprogram-ci exited ${run.status ?? run.signal}`);
