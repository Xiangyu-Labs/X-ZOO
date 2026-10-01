import path from 'node:path';

/** `guards` */
export const guardsRoot = path.resolve(import.meta.dirname, '../..');
/** The repository root: the pnpm workspace, plus `deploy/`, `docs/` and `.github/`. */
export const repoRoot = path.resolve(guardsRoot, '..');

export const webApp = path.join(repoRoot, 'apps/web');
export const coreSrc = path.join(repoRoot, 'packages/core/src');
export const migrationsDir = path.join(repoRoot, 'packages/db/migrations');
/** The Taro mini-program, the storefront (docs/mini). */
export const miniApp = path.join(repoRoot, 'apps/mini');
/** The storefront's typed `/api/v1` client, shared by the mini-program and its tests. */
export const apiClientSrc = path.join(repoRoot, 'packages/api-client/src');
/** The decoration blocks, rendered by the mini-program and by the admin's editor canvas. */
export const storefrontBlocksSrc = path.join(repoRoot, 'packages/storefront-blocks/src');
/** The storefront route catalogue: route key -> mini-program page (docs/mini/pages.md §3). */
export const storefrontRoutesFile = path.join(
  repoRoot,
  'packages/contracts/src/system/storefront-routes.ts',
);
/** The business-rule catalogue every rule ID is cited from. */
export const invariantsDoc = path.join(repoRoot, 'docs/invariants.md');
/** The OpenAPI document `pnpm gen` writes from the contracts (gitignored). */
export const openapiFile = path.join(repoRoot, 'packages/contracts/openapi.json');
/** The storefront API as the last released mini-program saw it (`api-compat`). */
export const apiBaselineFile = path.join(guardsRoot, 'baselines/storefront-api.json');
/** The workflow that builds, tests and publishes the shop. */
export const workflowFile = path.join(repoRoot, '.github/workflows/ci.yml');
export const deployWorkflowFile = path.join(repoRoot, '.github/workflows/deploy.yml');

/** A path as it is printed in a finding: relative to the repository root. */
export function rel(absolute: string): string {
  return path.relative(repoRoot, absolute).split(path.sep).join('/');
}
