import { shopConfig } from '@shop/config/eslint';

export default [
  ...shopConfig({ kind: 'testing', ignores: ['playwright-report/**', 'test-results/**'] }),
  {
    // The stack script and the edge are console programs: their progress *is*
    // the output, and a Playwright `webServer` is diagnosed from nothing else.
    files: ['scripts/**/*.ts', 'src/stack.ts', 'src/edge.ts', 'src/h5.ts'],
    rules: { 'no-console': 'off' },
  },
];
