import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = import.meta.dirname;
const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };
const serverTests = ['src/server/**/*.test.ts', 'app/**/route.test.ts'];
const intTests = ['src/**/*.int.test.ts', 'app/**/*.int.test.ts'];
const exclude = ['**/node_modules/**', '**/.next/**'];

/**
 * Three projects, named like the shared preset so `--project unit|int` means the same here:
 *
 *   unit         admin UI, happy-dom
 *   unit-server  `src/server` and route handlers, node
 *   int          anything needing PostgreSQL/Redis, through the @shop/testing harness
 */
export default defineConfig({
  test: {
    // Non-project options: each int file gets its own cloned database, but a 2-core box
    // should not fork ten postgres clients.
    pool: 'forks',
    maxWorkers: 4,
    teardownTimeout: 60_000,
    projects: [
      {
        // `tsconfig.json` sets `jsx: preserve` for Next; vitest's oxc transform has to be
        // told to compile JSX instead.
        oxc: { jsx: { runtime: 'automatic' } },
        resolve: { alias },
        test: {
          name: 'unit',
          root: here,
          environment: 'happy-dom',
          globals: true,
          // `timers.ts` first: it wraps the Node timer globals before React's
          // scheduler captures them, and cancels a file's leftovers so none can
          // reach React after happy-dom is torn down (the turbo-only
          // `window is not defined` flake; see that file).
          setupFiles: ['./src/test/timers.ts', './src/test/setup.ts'],
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'app/**/*.test.tsx'],
          exclude: [...exclude, ...serverTests, ...intTests],
          css: false,
          restoreMocks: true,
          // A full antd form render is ~1–2.5 s idle, but wall-clock time
          // grows with whatever else the box runs: a full `turbo run` (next
          // build, taro builds, every package's lint and tests) beside
          // parallel executors pushed the heaviest suites (diy panels, product
          // editor, groupbuy activities) past 20 s a test. This timeout is a
          // hang detector, not a speed budget, so it must outlast load. Fewer
          // workers would not help: the load is not ours (4 workers, 32 CPUs).
          // What was ours, happy-dom matching antd's stylesheets for every
          // `*ByRole`, is gone: see `src/test/render.tsx`.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'unit-server',
          root: here,
          environment: 'node',
          include: serverTests,
          exclude: [...exclude, ...intTests],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'int',
          root: here,
          environment: 'node',
          include: intTests,
          exclude,
          testTimeout: 30_000,
          hookTimeout: 180_000,
          globalSetup: [path.resolve(here, '../../packages/testing/src/harness/global-setup.ts')],
        },
      },
    ],
  },
});
