/**
 * Writes `packages/contracts/openapi.json`. Generated, gitignored, rebuilt by
 * `pnpm gen`; the merge gate diffs it rather than reviewing it by hand.
 *
 * Run: `pnpm --filter @shop/contracts openapi`
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { allRoutes } from '../src/routes.gen';
import { buildDocument } from './lib/openapi-doc';

const pkgRoot = path.resolve(import.meta.dirname, '..');

const doc = buildDocument(allRoutes);
await writeFile(path.join(pkgRoot, 'openapi.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log(
  `contracts: wrote openapi.json (${allRoutes.length} route(s), ${Object.keys(doc.paths ?? {}).length} path(s))`,
);
