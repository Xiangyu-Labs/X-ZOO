/**
 * The lint preset for code that runs in the WeChat mini-program: apps/mini, the decoration
 * blocks (@shop/storefront-blocks) and the runtime entries of @shop/api-client. AGENTS.md
 * rules 14 (only what WeChat and iOS 12 have), 17 (handlers return their promise) and 1 (no
 * error text in front of a shopper), checked where they are written.
 *
 *     import { weappConfig } from '@shop/config/eslint/weapp';
 *     export default [
 *       ...shopConfig({ kind: 'tooling' }),
 *       ...weappConfig({ files: ['src/**\/*.ts', 'src/**\/*.tsx'], ignores: ['src/**\/*.test.ts'] }),
 *     ];
 *
 * Why lint and not the build: DevTools' simulator, the H5 e2e build and Node's vitest all have
 * the newer APIs, so nothing before a phone shows the crash. Babel (`targets: { ios: '12' }`,
 * `useBuiltIns: false`) rewrites syntax but adds no polyfills, and the build's ES2018 parse
 * (apps/mini/scripts/size-report.mjs) accepts a lookbehind. The mini's tsconfig lib (ES2018)
 * refuses most of the methods below at typecheck; this catches them in the shared packages and
 * with a message that says what to use instead.
 *
 * This preset owns `no-restricted-globals`, `no-restricted-properties` and
 * `no-restricted-syntax` for the files it covers; a package that needs more passes
 * `extraGlobals` rather than re-declaring the rule (a later flat-config entry replaces the whole
 * rule, it does not merge).
 */

import { weappPlugin } from './weapp-rules.js';

/**
 * Globals a phone's mini-program runtime does not have, or has only as Taro's partial stand-in
 * (the build swaps `URLSearchParams`, `URL`, `window`, `document`… for its own, which lack most
 * of the browser API: `Object.fromEntries(new URLSearchParams(q))` threw on phones).
 */
export const WEAPP_MISSING_GLOBALS = [
  [
    'URLSearchParams',
    'Taro 的 URLSearchParams 不能遍历；小程序里用 src/lib/query.ts 的 parseQuery',
  ],
  ['URL', 'Taro 的 URL 不完整；手写拼接或 @shop/api-client/url'],
  ['window', '小程序没有 window'],
  ['document', '小程序没有 document'],
  ['navigator', '小程序没有 navigator；系统信息走 src/platform'],
  ['location', '小程序没有 location；路由走 src/platform/nav.ts'],
  ['history', '小程序没有 history；路由走 src/platform/nav.ts'],
  ['localStorage', '小程序没有 localStorage；存储走 src/platform'],
  ['sessionStorage', '小程序没有 sessionStorage；存储走 src/platform'],
  ['fetch', '小程序没有 fetch；请求走 @shop/api-client'],
  ['XMLHttpRequest', '小程序没有 XMLHttpRequest；请求走 @shop/api-client'],
  ['FormData', '小程序没有 FormData；上传走 src/platform'],
  ['Blob', '小程序没有 Blob'],
  ['File', '小程序没有 File'],
  ['FileReader', '小程序没有 FileReader；文件走 src/platform'],
  ['btoa', '小程序没有 btoa'],
  ['atob', '小程序没有 atob'],
  ['TextEncoder', '小程序没有 TextEncoder'],
  ['TextDecoder', '小程序没有 TextDecoder'],
  ['structuredClone', '小程序没有 structuredClone'],
  ['requestAnimationFrame', '小程序页面里没有 requestAnimationFrame；用 setTimeout'],
  ['cancelAnimationFrame', '小程序页面里没有 cancelAnimationFrame'],
  ['IntersectionObserver', '用 src/platform 包装的 Taro.createIntersectionObserver'],
  ['ResizeObserver', '小程序没有 ResizeObserver'],
  ['MutationObserver', '小程序没有 MutationObserver'],
  ['matchMedia', '小程序没有 matchMedia'],
  ['getComputedStyle', '小程序没有 getComputedStyle'],
  ['queueMicrotask', 'iOS 老版本没有 queueMicrotask；用 Promise.resolve().then'],
  ['setImmediate', '小程序没有 setImmediate'],
  ['crypto', '小程序没有 Web Crypto'],
  ['globalThis', 'iOS 12.0/12.1 没有 globalThis'],
  ['WeakRef', 'iOS 12 没有 WeakRef'],
  ['FinalizationRegistry', 'iOS 12 没有 FinalizationRegistry'],
  ['AggregateError', 'iOS 12 没有 AggregateError'],
  ['BigInt', 'iOS 12 没有 BigInt'],
].map(([name, message]) => ({ name, message }));

/**
 * Methods newer than the iOS 12 floor, which Babel does not polyfill. A property ban without an
 * object matches any receiver: these names mean nothing else in this codebase.
 */
export const WEAPP_MISSING_METHODS = [
  {
    object: 'Object',
    property: 'fromEntries',
    message: 'iOS 12.0/12.1 没有 Object.fromEntries；小程序里用 src/lib/defined.ts 的 fromPairs',
  },
  {
    object: 'Object',
    property: 'hasOwn',
    message: 'iOS 12 没有 Object.hasOwn；用 Object.prototype.hasOwnProperty.call',
  },
  { object: 'Object', property: 'groupBy', message: 'iOS 12 没有 Object.groupBy' },
  { object: 'Map', property: 'groupBy', message: 'iOS 12 没有 Map.groupBy' },
  { object: 'Promise', property: 'any', message: 'iOS 12 没有 Promise.any' },
  {
    object: 'Promise',
    property: 'allSettled',
    message: 'iOS 12 没有 Promise.allSettled；各自 .then(ok, fail) 后 Promise.all',
  },
  { object: 'Promise', property: 'withResolvers', message: 'iOS 12 没有 Promise.withResolvers' },
  { object: 'Array', property: 'fromAsync', message: 'iOS 12 没有 Array.fromAsync' },
  { object: 'Intl', property: 'ListFormat', message: 'iOS 12 没有 Intl.ListFormat' },
  {
    object: 'Intl',
    property: 'RelativeTimeFormat',
    message: 'iOS 12 没有 Intl.RelativeTimeFormat',
  },
  { object: 'Intl', property: 'Segmenter', message: 'iOS 12 没有 Intl.Segmenter' },
  { property: 'matchAll', message: 'iOS 12 没有 String.prototype.matchAll；用 RegExp exec 循环' },
  { property: 'replaceAll', message: 'iOS 12 没有 replaceAll；用带 g 的正则 replace' },
  { property: 'findLast', message: 'iOS 12 没有 findLast；倒序循环' },
  { property: 'findLastIndex', message: 'iOS 12 没有 findLastIndex；倒序循环' },
  { property: 'toSorted', message: 'iOS 12 没有 toSorted；[...a].sort()' },
  { property: 'toReversed', message: 'iOS 12 没有 toReversed；[...a].reverse()' },
  { property: 'toSpliced', message: 'iOS 12 没有 toSpliced' },
];

const RESTRICTED_SYNTAX = [
  {
    selector: "NewExpression[callee.name='Function']",
    message: 'new Function 被静态守卫禁止',
  },
  {
    selector: "CallExpression[callee.property.name='at'][arguments.length=1]",
    message: 'iOS 12 没有 Array/String.prototype.at；用 [i] 或 [length - 1]',
  },
  {
    selector: 'Literal[bigint]',
    message: 'iOS 12 没有 BigInt',
  },
];

/**
 * @param {{
 *   files: string[],
 *   ignores?: string[],
 *   uiIgnores?: string[],
 *   extraGlobals?: Array<{ name: string, message: string }>,
 * }} options
 *   `files` / `ignores`: what runs on the phone (not tests, not build-time config, not
 *   H5-only code). `uiIgnores`: further files exempt from `no-raw-error-text` only — the layer
 *   that turns raw errors into Chinese (the mini's src/platform and src/lib/error-message.ts).
 * @returns {import('eslint').Linter.Config[]}
 */
export function weappConfig(options) {
  const { files, ignores = [], uiIgnores = [], extraGlobals = [] } = options;
  return [
    {
      files,
      ignores,
      plugins: { weapp: weappPlugin },
      rules: {
        'no-restricted-globals': ['error', ...WEAPP_MISSING_GLOBALS, ...extraGlobals],
        'no-restricted-properties': ['error', ...WEAPP_MISSING_METHODS],
        'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX],
        'weapp/no-unsupported-regex': 'error',
        'weapp/no-void-handler': 'error',
      },
    },
    {
      files,
      ignores: [...ignores, ...uiIgnores],
      plugins: { weapp: weappPlugin },
      rules: { 'weapp/no-raw-error-text': 'error' },
    },
  ];
}

export default weappConfig;
