import { shopConfig } from '@shop/config/eslint';
import { weappConfig } from '@shop/config/eslint/weapp';

/**
 * What must stay out of the runtime of the main and react entries, which ship
 * in the mini-program: zod and the contracts (types only), the validate entry,
 * any `@tarojs/*` (the app passes `Taro.request` in), and the web/Node globals
 * the mini-program runtime does not have.
 */
const RUNTIME_FILES = ['src/**/*.ts'];
const NOT_RUNTIME = ['src/**/*.test.ts', 'src/validate.ts', 'src/test-support/**'];

export default [
  ...shopConfig({ kind: 'tooling' }),
  // AGENTS.md 14, 17 and 1: what the mini-program's runtime lacks, plus the Node and web
  // globals a client library reaches for.
  ...weappConfig({
    files: RUNTIME_FILES,
    ignores: NOT_RUNTIME,
    extraGlobals: [
      { name: 'AbortController', message: '小程序运行时没有 AbortController' },
      { name: 'Buffer', message: '小程序运行时没有 Buffer' },
      { name: 'process', message: '小程序运行时没有 process' },
    ],
  }),
  {
    files: RUNTIME_FILES,
    ignores: NOT_RUNTIME,
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'zod',
              allowTypeImports: true,
              message:
                '主入口只能 import type zod：zod 不能进入小程序包（用 @shop/api-client/validate）',
            },
          ],
          patterns: [
            {
              group: ['@shop/contracts', '@shop/contracts/*'],
              allowTypeImports: true,
              message: '主入口只能 import type 契约：运行时只用生成的精简路由表',
            },
            {
              group: ['./validate', '../validate', '@shop/api-client/validate'],
              message: '主入口不能引用 validate：它会把全部契约和 zod 带进包里',
            },
            {
              group: ['@tarojs/*'],
              message: 'api-client 不依赖 Taro：由应用把 Taro.request 传给 taroTransport',
            },
          ],
        },
      ],
    },
  },
];
