import { shopConfig } from '@shop/config/eslint';

export default [
  ...shopConfig({ kind: 'tooling' }),
  {
    // The guards *are* a command-line report: printing is the output.
    files: ['src/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
];
