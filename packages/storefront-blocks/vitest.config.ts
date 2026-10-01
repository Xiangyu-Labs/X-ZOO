import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = import.meta.dirname;
const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Blocks render through the DOM shim in tests, as they do in the admin canvas. */
const shim = { '@tarojs/components': local('./src/dom/index.tsx') };

/**
 * The blocks must work on both Reacts (plan §6): the mini-program runs 18, the
 * admin 19. Two projects over the same files:
 *
 *   unit           React 19 (the package's own devDependency)
 *   unit-react18   React 18, by aliasing `react` / `react-dom` to the
 *                  `react-18` / `react-dom-18` npm aliases
 *
 * Rendering goes through `src/test/render.tsx`, so the alias reaches `react-dom` too.
 * pnpm links `react-dom-18` against the package's React 19 (its peer), so
 * `src/test/react18-hooks.ts` redirects React DOM 18's own `require('react')`.
 */
const base = {
  root: here,
  environment: 'happy-dom' as const,
  include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
  exclude: ['**/node_modules/**', '**/dist/**'],
  css: false,
};

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    projects: [
      {
        oxc: { jsx: { runtime: 'automatic' } },
        resolve: { alias: shim },
        test: { ...base, name: 'unit', provide: { reactMajor: '19' } },
      },
      {
        oxc: { jsx: { runtime: 'automatic' } },
        resolve: {
          alias: [
            { find: '@tarojs/components', replacement: shim['@tarojs/components'] },
            // Absolute, so the alias resolves from inside Testing Library as well.
            {
              find: /^react-dom(\/.*)?$/,
              replacement: `${local('./node_modules/react-dom-18')}$1`,
            },
            { find: /^react(\/.*)?$/, replacement: `${local('./node_modules/react-18')}$1` },
          ],
        },
        test: {
          ...base,
          name: 'unit-react18',
          provide: { reactMajor: '18' },
          setupFiles: ['./src/test/react18-hooks.ts'],
        },
      },
    ],
  },
});
