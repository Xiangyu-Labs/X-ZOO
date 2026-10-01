import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * `load` is a directory of scripts, not a workspace package, so it has no
 * dependencies of its own. Every dependency is resolved *as if*
 * imported from `@shop/e2e-admin`, which already depends on `@shop/core`,
 * `@shop/db`, `@shop/testing`, `pg` and `tsx` — and the scripts run through
 * that package's `tsx`:
 *
 *     pnpm --filter @shop/e2e-admin exec tsx ../../load/run.ts
 *
 * A static `import '@shop/core/…'` from this directory would not resolve (there
 * is no `load/node_modules`), hence the dynamic import through a
 * `require.resolve` anchored at the e2e package.
 */

export const NEXT_DIR = path.resolve(import.meta.dirname, '../..');
const ANCHOR = path.join(NEXT_DIR, 'e2e/admin/package.json');
const requireFromE2E = createRequire(ANCHOR);

export async function dep<T = any>(specifier: string): Promise<T> {
  const resolved = requireFromE2E.resolve(specifier);
  return (await import(pathToFileURL(resolved).href)) as T;
}
