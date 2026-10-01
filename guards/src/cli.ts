/**
 * `pnpm guards` — the static checks over the whole tree.
 *
 * Runs every check, prints one line per check plus every finding, and exits 1
 * if anything failed.
 *
 *   pnpm guards                 every check (from the workspace root)
 *   pnpm --filter @shop/guards guards contracts        one or more checks by name
 *   pnpm --filter @shop/guards guards --json           machine-readable, for CI annotations
 *   pnpm --filter @shop/guards guards --quiet          only the summary and the failures
 */
import { adminClient } from './checks/admin-client';
import { adminPermissions } from './checks/admin-permissions';
import { apiCompat } from './checks/api-compat';
import { bannedConstructs } from './checks/banned';
import { contractsAndRoutes } from './checks/contracts';
import { counters } from './checks/counters';
import { domains } from './checks/domains';
import { fixtures } from './checks/fixtures';
import { invariants } from './checks/invariants';
import { literals } from './checks/literals';
import { migrations } from './checks/migrations';
import { miniCheck } from './checks/mini';
import { miniStyles } from './checks/mini-styles';
import { permissions } from './checks/permissions';
import { personalData } from './checks/personal-data';
import { pipeline } from './checks/pipeline';
import { retiredFeatures } from './checks/retired';
import { routeHygiene } from './checks/route-hygiene';
import { secretsNeverLeak } from './checks/secrets';
import { txPool } from './checks/tx-pool';
import { count, type Check, type CheckResult } from './framework';

const CHECKS: readonly Check[] = [
  domains,
  contractsAndRoutes,
  routeHygiene,
  permissions,
  adminClient,
  adminPermissions,
  fixtures,
  miniCheck,
  miniStyles,
  retiredFeatures,
  bannedConstructs,
  secretsNeverLeak,
  personalData,
  txPool,
  counters,
  literals,
  migrations,
  pipeline,
  apiCompat,
  invariants,
];

const args = process.argv.slice(2);
const json = args.includes('--json');
const quiet = args.includes('--quiet');
const selected = args.filter((a) => !a.startsWith('--'));

const chosen =
  selected.length === 0 ? CHECKS : CHECKS.filter((check) => selected.includes(check.name));

if (chosen.length === 0) {
  console.error(`no such check: ${selected.join(', ')}`);
  console.error(`known: ${CHECKS.map((c) => c.name).join(', ')}`);
  process.exit(2);
}

const results: CheckResult[] = [];
for (const check of chosen) {
  results.push(await check.run());
}

const failures = results.reduce((n, r) => n + count(r.findings, 'fail'), 0);

if (json) {
  console.log(JSON.stringify({ results, failures }, null, 2));
} else {
  for (const check of results) {
    const failed = count(check.findings, 'fail');
    const mark = failed > 0 ? 'FAIL' : 'ok  ';
    console.log(`${mark} ${check.name.padEnd(14)} ${check.summary}`);
    for (const finding of check.findings) {
      if (quiet && finding.level !== 'fail') continue;
      const tag = finding.level === 'fail' ? '  ✗' : '  ·';
      console.log(`${tag} ${finding.where}: ${finding.message}`);
    }
  }
  console.log('');
  console.log(`${results.length} checks, ${failures} failure(s)`);
}

process.exit(failures > 0 ? 1 : 0);
