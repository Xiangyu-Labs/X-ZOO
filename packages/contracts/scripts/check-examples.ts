/**
 * CLI wrapper around `checkRoutes`. See `scripts/lib/check.ts` for what it checks.
 *
 * Run: `pnpm --filter @shop/contracts check:examples`
 */
import { allRoutes, routeSources } from '../src/routes.gen';
import { checkRoutes } from './lib/check';

const problems = checkRoutes(allRoutes);
if (problems.length > 0) {
  for (const p of problems) {
    console.error(`✗ ${p.routeId} (${routeSources[p.routeId] ?? '?'}) [${p.where}] ${p.detail}`);
  }
  console.error(`\n${problems.length} contract problem(s).`);
  process.exit(1);
}
console.log(`contracts: ${allRoutes.length} route(s) OK, every example parses.`);
