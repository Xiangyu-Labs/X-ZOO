import { shopConfig } from '@shop/config/eslint';
import { weappConfig } from '@shop/config/eslint/weapp';

/**
 * The blocks are pure presentation: they render what they are given and report
 * taps through props. Everything platform-specific (navigation, requests,
 * `pxTransform`) belongs to the host — the mini-program or the admin canvas.
 *
 * They ship in the mini-program, so the weapp preset (AGENTS.md 14, 17, 1)
 * covers everything but the admin canvas's DOM shim and the tests.
 */
export default [
  ...shopConfig({
    kind: 'tooling',
    ignores: ['fidelity/.out/**'],
    extraDeny: [
      {
        source: '^@tarojs/taro$|^@tarojs/taro/',
        exceptFrom: '/(scripts|fidelity)/',
        message: '装修块是纯展示组件：不得调用 Taro API（跳转、请求等由宿主通过 props 注入）',
      },
      {
        source: '^(next|next/.*|antd|@ant-design/.*|@shop/(core|db|web)(/.*)?)$',
        message: '装修块要同时在小程序和后台画布里渲染，不得依赖后台或服务端的包',
      },
    ],
  }),
  ...weappConfig({
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: [
      // The admin canvas's stand-in for @tarojs/components: it runs in a browser.
      'src/dom/**',
      // The editor's entry (zod): a client bundle never imports it, the blocks take its types.
      'src/schema/**',
      'src/admin.ts',
      'src/admin-css.ts',
      'src/test/**',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'src/**/*.d.ts',
    ],
  }),
];
