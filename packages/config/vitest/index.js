/**
 * Shared Vitest presets.
 *
 * Every package gets two projects, matching the convention in
 * `docs/conventions.md`:
 *
 *   unit  `src/**\/*.test.ts`      — no PostgreSQL, no Redis, no Docker
 *   int   `src/**\/*.int.test.ts`  — real PG 17 + Redis 7 via the @shop/testing harness
 *
 * so that `vitest run --project unit` and `--project int` are the only two
 * commands anyone needs. `test:unit` must stay runnable on a machine without
 * Docker.
 */

const UNIT_INCLUDE = ['src/**/*.test.ts'];
const INT_INCLUDE = ['src/**/*.int.test.ts'];
const ALWAYS_EXCLUDE = ['**/node_modules/**', '**/dist/**', '**/.next/**'];

/**
 * @typedef {object} ShopVitestOptions
 * @property {string} dirname            Package root, pass `import.meta.dirname`.
 * @property {string} [intGlobalSetup]   Path to the Testcontainers globalSetup module.
 * @property {Record<string, string>} [alias] Extra vite resolve aliases.
 * @property {string[]} [unitInclude]
 * @property {string[]} [intInclude]
 * @property {string[]} [setupFiles]
 * @property {unknown[]} [extraProjects] Extra vitest projects appended after
 *   `unit` and `int`.
 */

/** @param {ShopVitestOptions} options */
export function shopVitest(options) {
  const {
    dirname,
    intGlobalSetup,
    alias = {},
    unitInclude = UNIT_INCLUDE,
    intInclude = INT_INCLUDE,
    setupFiles = [],
    extraProjects = [],
  } = options;
  /** @type {{ alias: Record<string, string> }} */
  const resolve = { alias };

  return {
    test: {
      projects: [
        {
          resolve,
          test: {
            // Project names are NOT package-prefixed so that `--project unit`
            // and `--project int` mean the same thing in every package.
            name: 'unit',
            root: dirname,
            environment: 'node',
            include: unitInclude,
            exclude: [...ALWAYS_EXCLUDE, ...intInclude],
            setupFiles,
          },
        },
        {
          resolve,
          test: {
            name: 'int',
            root: dirname,
            environment: 'node',
            include: intInclude,
            exclude: ALWAYS_EXCLUDE,
            setupFiles,
            // Containers are slow to pull the first time; individual tests are not.
            testTimeout: 30_000,
            hookTimeout: 180_000,
            teardownTimeout: 60_000,
            // Each test file gets its own cloned database, so files may run in
            // parallel, but a 2-core box should not fork ten postgres clients.
            pool: 'forks',
            maxWorkers: 4,
            minWorkers: 1,
            ...(intGlobalSetup ? { globalSetup: [intGlobalSetup] } : {}),
          },
        },
        ...extraProjects,
      ],
    },
  };
}

export default shopVitest;
