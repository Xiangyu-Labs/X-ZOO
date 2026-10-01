import path from 'node:path';
import { shopVitest } from '@shop/config/vitest';

const here = import.meta.dirname;
const nm = (name: string) => path.join(here, 'node_modules', name);

/**
 * The hooks also run against React 18, which is what Taro ships, while the
 * default project runs them on React 19 (the admin's). `react` and
 * `react-dom` are aliased to the `react-18` / `react-dom-18` dev dependencies,
 * and TanStack Query is inlined so the alias reaches its `import 'react'` too;
 * otherwise it would load React 19 and the hooks would run on two Reacts at
 * once. `react-dom` 18 is CommonJS, so no alias reaches its own
 * `require('react')`, and pnpm resolved that peer to the package's React 19:
 * `test-support/react18-setup.ts` points it at React 18. (Testing Library
 * cannot be redirected either, hence `test-support/render-hook.ts`.)
 */
const react18 = {
  resolve: {
    alias: [
      { find: /^react$/, replacement: nm('react-18') },
      { find: /^react\/(.*)$/, replacement: `${nm('react-18')}/$1` },
      { find: /^react-dom$/, replacement: nm('react-dom-18') },
      { find: /^react-dom\/(.*)$/, replacement: `${nm('react-dom-18')}/$1` },
    ],
  },
  test: {
    name: 'unit-react18',
    root: here,
    environment: 'node',
    include: ['src/react.test.ts'],
    server: { deps: { inline: ['@tanstack/react-query'] } },
    setupFiles: [path.join(here, 'src/test-support/react18-setup.ts')],
  },
};

export default shopVitest({ dirname: here, extraProjects: [react18] });
