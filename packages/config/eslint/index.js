/**
 * Shared ESLint flat config (eslint 10 + typescript-eslint 8).
 *
 * Usage, in each package's `eslint.config.js`:
 *
 *     import { shopConfig } from '@shop/config/eslint';
 *     export default shopConfig({ kind: 'core' });
 *
 * `kind` picks the import-boundary rule set. Everything else is shared.
 * Linting is intentionally NOT type-aware: it has to stay fast enough to run
 * on every commit.
 */

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { boundariesPlugin } from './boundaries.js';

/** @typedef {'core' | 'db' | 'contracts' | 'testing' | 'app-server' | 'admin-ui' | 'worker' | 'tooling'} PackageKind */

const NEXT_AND_REACT = '^(next|next/.*|react|react-dom|react/.*|antd|@ant-design/.*)$';

/** @type {Record<PackageKind, Array<{source: string, from?: string, exceptFrom?: string, message: string}>>} */
const DENY = {
  core: [
    {
      source: NEXT_AND_REACT,
      message:
        'packages/core 不得依赖 next / react / UI 库（docs/conventions.md「Import boundaries」）',
    },
    { source: '^@shop/web', message: 'packages/core 不得依赖 apps/*' },
    {
      source: '^@shop/db/schema/',
      // Tests assert on rows, so they may read tables directly.
      exceptFrom: '\\.repo\\.ts$|\\.test\\.ts$',
      message: '只有 *.repo.ts 可以直接访问 Drizzle 表',
    },
  ],
  db: [{ source: NEXT_AND_REACT, message: 'packages/db 不得依赖 next / react' }],
  contracts: [
    { source: NEXT_AND_REACT, message: 'packages/contracts 不得依赖 next / react' },
    { source: '^@shop/(core|db)$|^@shop/(core|db)/', message: 'contracts 是最底层，不得反向依赖' },
  ],
  testing: [],
  worker: [],
  'app-server': [
    {
      source: '^@shop/db/schema/',
      message: 'route/server 层不得直接访问 Drizzle 表，走 core 的 *.repo.ts',
    },
  ],
  'admin-ui': [
    {
      source: '^@shop/core$|^@shop/core/|^@shop/db$|^@shop/db/',
      message: '后台 UI 只能引用 @shop/contracts 和生成的客户端',
    },
  ],
  tooling: [],
};

/**
 * @param {{ kind: PackageKind, ignores?: string[], extraDeny?: Array<{source: string, from?: string, exceptFrom?: string, message: string}> }} options
 * @returns {import('eslint').Linter.Config[]}
 */
export function shopConfig(options) {
  const { kind, ignores = [], extraDeny = [] } = options;
  const deny = [...(DENY[kind] ?? []), ...extraDeny];

  return tseslint.config(
    {
      ignores: [
        '**/dist/**',
        '**/.next/**',
        '**/.turbo/**',
        '**/node_modules/**',
        '**/coverage/**',
        '**/*.gen.ts',
        ...ignores,
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      languageOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        globals: { ...globals.node, ...globals.es2023 },
      },
      plugins: { boundaries: boundariesPlugin },
      rules: {
        'boundaries/no-restricted-source': deny.length ? ['error', { deny }] : 'off',
        'boundaries/core-cross-domain': kind === 'core' ? 'error' : 'off',

        // Things that have actually bitten this codebase before.
        'no-eval': 'error',
        'no-implied-eval': 'error',
        'no-new-func': 'error',
        'no-console': ['error', { allow: ['warn', 'error'] }],
        eqeqeq: ['error', 'smart'],
        'no-restricted-syntax': [
          'error',
          {
            selector: "NewExpression[callee.name='Function']",
            message: 'new Function 被静态守卫禁止',
          },
        ],

        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/no-explicit-any': 'warn',
        '@typescript-eslint/no-empty-object-type': 'off',
      },
    },
    {
      // Scripts and tests may print and may be looser.
      files: [
        '**/scripts/**',
        '**/*.test.ts',
        '**/*.int.test.ts',
        '**/mock-server/**',
        '**/harness/**',
        '**/*.js',
      ],
      rules: {
        'no-console': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
    {
      // Reading the ambient clock is banned in domain code
      // (`docs/conventions.md`: "inject `Clock`; never call `Date.now()` in
      // domain code").
      files: ['packages/core/src/**/*.ts', 'src/**/*.ts'],
      ignores: [
        '**/*.test.ts',
        '**/*.int.test.ts',
        '**/kernel/clock.ts',
        '**/kernel/storage.ts',
        '**/scripts/**',
      ],
      rules: {
        'no-restricted-properties':
          kind === 'core'
            ? [
                'error',
                {
                  object: 'Date',
                  property: 'now',
                  message: '领域代码注入 Clock，不要直接读系统时间（docs/conventions.md「Time」）',
                },
              ]
            : 'off',
        // `new Date()` with no argument is the same defect, and it is the one
        // that actually shipped: an effect recorded from the ambient clock was
        // never claimed by a dispatcher running on a fixed one. `new Date(x)`
        // stays allowed — that is arithmetic on an injected instant.
        'no-restricted-syntax':
          kind === 'core'
            ? [
                'error',
                {
                  selector: "NewExpression[callee.name='Function']",
                  message: 'new Function 被静态守卫禁止',
                },
                {
                  selector: "NewExpression[callee.name='Date'][arguments.length=0]",
                  message:
                    '领域代码注入 Clock：用 ctx.clock.now()，不要 new Date()（docs/conventions.md「Time」）',
                },
              ]
            : 'off',
      },
    },
  );
}

export default shopConfig;
