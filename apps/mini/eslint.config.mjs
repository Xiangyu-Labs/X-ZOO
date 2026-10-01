import { shopConfig } from '@shop/config/eslint';
import { weappConfig } from '@shop/config/eslint/weapp';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * The mini-program's lint. The shared preset resolves typescript-eslint against its own
 * TypeScript 6 (docs/conventions.md, "Tooling caveats"), so no shim is needed here.
 *
 * The boundaries are what keep the main package small and the platform swappable:
 *
 * - nothing server-side (`@shop/core`, `@shop/db`, `@shop/testing`) and no zod at runtime;
 * - `@shop/contracts` for types only, except the zod-free modules listed below;
 * - `Taro.*` platform APIs only inside `src/platform/` (pages may use Taro's hooks).
 */

/** Lifecycle hooks and helpers of `@tarojs/taro` that any component may import. */
const TARO_HOOKS = [
  'useDidHide',
  'useDidShow',
  'useLaunch',
  'useLoad',
  'usePageScroll',
  'usePullDownRefresh',
  'useReachBottom',
  'useReady',
  'useResize',
  'useRouter',
  'useShareAppMessage',
  'useShareTimeline',
  'useTabItemTap',
  'useUnload',
];

/**
 * The workspace has one `@types/react` (19, shared with apps/web; see docs/mini/spikes/S1-taro.md)
 * but the mini-program runs React 18. These type-check and then fail at runtime.
 */
const REACT_19_ONLY = {
  name: 'react',
  importNames: ['use', 'useActionState', 'useOptimistic'],
  message: '小程序运行的是 React 18（Taro 4.2），没有这个 API',
};

const SERVE_API =
  '用 serveApi（src/test/fake-api.ts）答复请求：它按契约检查请求和答复（AGENTS.md 20）';

/** Ways a test could answer a request without serveApi. (esquery regexes cannot hold a `/`.) */
const RAW_REQUEST_MOCKS = [
  {
    selector: "NewExpression[callee.name='Function']",
    message: 'new Function 被静态守卫禁止',
  },
  {
    selector:
      "AssignmentExpression > MemberExpression.left[object.name='taroFake'][property.name=/^(onRequest|request)$/]",
    message: SERVE_API,
  },
  {
    selector:
      "CallExpression[callee.object.name='vi'][callee.property.name='stubGlobal'][arguments.0.value=/^(fetch|XMLHttpRequest)$/]",
    message: SERVE_API,
  },
  {
    selector:
      "CallExpression[callee.object.name='vi'][callee.property.name='spyOn'][arguments.1.value=/^(request|uploadFile)$/]",
    message: SERVE_API,
  },
  {
    selector:
      "CallExpression[callee.object.name='vi'][callee.property.name=/^(mock|doMock)$/][arguments.0.value=/^(@shop.api-client|@tarojs.taro$|@.data.api$)/]",
    message: `${SERVE_API}；@tarojs/taro 已经换成 src/test/taro-fake`,
  },
];

/** `@shop/contracts` modules with no zod import, allowed at runtime. */
const CONTRACTS_RUNTIME = [
  '@shop/contracts/decor/link-route',
  '@shop/contracts/storage/image-variants',
  '@shop/contracts/system/theme',
];

export default [
  ...shopConfig({
    kind: 'tooling',
    ignores: ['.swc/**', '.bundle-stats/**'],
    extraDeny: [
      {
        source: '^@shop/(core|db|testing)(/|$)',
        message: '小程序不得依赖服务端包（core / db / testing）',
      },
      {
        source: '^zod($|/)',
        exceptFrom: '\\.test\\.tsx?$',
        message: '小程序运行时不带 zod（包体积；契约只 import 类型）',
      },
    ],
  }),
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: `^@shop/contracts(?!(${CONTRACTS_RUNTIME.map((m) => m.slice('@shop/contracts'.length)).join('|')})$)(/.*)?$`,
              allowTypeImports: true,
              message: '契约只 import 类型（import type），运行时不带 zod',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/platform/**', 'src/test/**', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            REACT_19_ONLY,
            {
              name: '@tarojs/taro',
              allowImportNames: TARO_HOOKS,
              message: '平台 API 只在 src/platform 里调用；页面只用 Taro 的生命周期 hooks',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/platform/**', 'src/test/**', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    rules: { 'no-restricted-imports': ['error', { paths: [REACT_19_ONLY] }] },
  },
  // What runs on the phone: AGENTS.md 14 (only what WeChat and iOS 12 have), 17 (handlers
  // return their promise) and 1 (no raw error text for the shopper); packages/config/eslint/weapp.js.
  ...weappConfig({
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: [
      // Build time, in Node: the app and page configs become app.json / page .json files.
      'src/app.config.ts',
      'src/**/index.config.ts',
      // H5-only: the e2e emulation and the DIY preview run in a browser.
      'src/platform/*.h5.ts',
      'src/platform/*.h5.tsx',
      'src/platform/h5-*.ts',
      'src/platform/h5-*.tsx',
      'src/test/**',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
    ],
    // The layer that turns WeChat's errMsg and runtime errors into Chinese.
    uiIgnores: ['src/platform/**', 'src/lib/error-message.ts'],
  }),
  {
    files: ['src/**/*.tsx', 'src/**/*.ts'],
    ...reactHooks.configs.flat.recommended,
  },
  {
    // Tests may reach the fake runtime directly.
    files: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/test/**'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // A test answers requests through serveApi (src/test/fake-api.ts), which holds each stub and
    // each request to the contracts: a hand-rolled answer passes on a page that breaks against
    // the real server (AGENTS.md 20). The H5 emulation's tests talk to its own `/__e2e/`
    // endpoints over fetch, which no contract describes.
    files: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    ignores: ['src/test/**', 'src/platform/h5-*.test.ts', 'src/platform/h5-*.test.tsx'],
    rules: { 'no-restricted-syntax': ['error', ...RAW_REQUEST_MOCKS] },
  },
];
