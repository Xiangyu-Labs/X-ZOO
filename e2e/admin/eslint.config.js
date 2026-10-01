import { shopConfig } from '@shop/config/eslint';

export default [
  ...shopConfig({ kind: 'testing', ignores: ['playwright-report/**', 'test-results/**'] }),
  {
    // The stack script is a console program: its progress *is* the output, and
    // a Playwright `webServer` is diagnosed from nothing else.
    files: ['scripts/**/*.ts', 'src/stack.ts'],
    rules: { 'no-console': 'off' },
  },
];
