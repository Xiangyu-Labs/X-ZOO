/**
 * `pnpm --filter @shop/guards api-compat:refresh --release <version>` — rewrites
 * `guards/baselines/storefront-api.json`, the storefront API the `api-compat`
 * check holds the tree to.
 *
 * Run it **only when a mini-program version is released** (docs/mini/cutover.md
 * §5), with that version (`apps/mini/package.json`): from then on every
 * installed copy of that version depends on exactly this surface. Refreshing at
 * any other time forgives a breaking change that released clients will still
 * hit.
 *
 *   --release <x.y.z>  a release: records the version.
 *   --unreleased       before the first release only (nothing is installed
 *                      yet); refused once the baseline records a release.
 *
 * The package script regenerates the contracts' OpenAPI document first, then
 * runs this. It prints what the new baseline forgives, so the release commit
 * says which breaking changes were accepted.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  BASELINE_COMMENT,
  readBaseline,
  readCurrentSurface,
  type Baseline,
} from '../src/checks/api-compat';
import { diffSurfaces, formatChange } from '../src/lib/api-compat';
import { apiBaselineFile, miniApp, openapiFile, rel } from '../src/lib/paths';

const out = (line = '') => process.stdout.write(`${line}\n`);
const die = (message: string): never => {
  process.stderr.write(`api-compat:refresh: ${message}\n`);
  process.exit(2);
};

const args = process.argv.slice(2).filter((a) => a !== '--');
const releaseAt = args.indexOf('--release');
const unreleased = args.includes('--unreleased');
const release = releaseAt >= 0 ? args[releaseAt + 1] : undefined;

if (releaseAt >= 0 === unreleased) {
  die('pass exactly one of `--release <version>` (a mini-program release) or `--unreleased`');
}
if (releaseAt >= 0 && (release === undefined || !/^\d+\.\d+\.\d+$/.test(release))) {
  die('`--release` takes the released version, x.y.z (apps/mini/package.json `version`)');
}

const previous = readBaseline();
if (unreleased && previous?.release) {
  die(
    `the baseline records release ${previous.release}; after a release it is refreshed only ` +
      'with `--release <version>` at the next one',
  );
}

const miniVersion = (
  JSON.parse(fs.readFileSync(path.join(miniApp, 'package.json'), 'utf8')) as { version?: string }
).version;
if (release !== undefined && miniVersion !== release) {
  out(`warning: apps/mini/package.json says ${miniVersion ?? '(none)'}, not ${release}`);
}

const operations = readCurrentSurface() ?? die(`${rel(openapiFile)} is missing: run \`pnpm gen\``);

if (previous) {
  const changes = diffSurfaces(previous.operations, operations);
  const breaking = changes.filter((c) => c.severity === 'breaking');
  out(
    `against ${previous.release === null ? 'the unreleased snapshot' : `release ${previous.release}`}: ` +
      `${breaking.length} breaking change(s) accepted by this refresh`,
  );
  for (const change of breaking) out(`  ✗ ${formatChange(change)}`);
}

const baseline: Baseline = {
  $comment: BASELINE_COMMENT,
  release: release ?? null,
  operations,
};
fs.mkdirSync(path.dirname(apiBaselineFile), { recursive: true });
fs.writeFileSync(apiBaselineFile, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
out(
  `wrote ${rel(apiBaselineFile)}: ${Object.keys(operations).length} operation(s), ` +
    `release ${baseline.release ?? '(unreleased)'}`,
);
