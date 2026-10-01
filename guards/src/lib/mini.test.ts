import { describe, expect, it } from 'vitest';
import {
  exportedInitializer,
  isNutUi,
  pageOfConfigFile,
  privateOpenTypes,
  registeredPages,
  requiredPrivateInfos,
  specifiersOf,
  tabBarPaths,
  taroApiUses,
  urlLiterals,
} from './mini';

/**
 * The readers the `mini` check stands on, against small strings. The check as a
 * whole is proved by mutation (`checks/mini.mutations.test.ts`); these pin the
 * edges a mutation does not reach — comments, type-only imports, aliases.
 */

describe('taroApiUses', () => {
  it('finds Taro.x and wx.x member references', () => {
    const uses = taroApiUses('Taro.navigateTo({ url });\nconst r = wx.request({});\n');
    expect(uses.map((u) => [u.via, u.line])).toEqual([
      ['Taro.navigateTo', 1],
      ['wx.request', 2],
    ]);
  });

  it('ignores comments and properties that merely end in wx or Taro', () => {
    const source = [
      '// Taro.login is called by the platform',
      '/* wx.requestPayment */',
      'ctx.wx.request();',
      'myTaro.navigateTo();',
    ].join('\n');
    expect(taroApiUses(source)).toEqual([]);
  });

  it('reports the default import and each named import, not type-only ones', () => {
    const source = [
      "import Taro, { useDidShow, navigateTo as go } from '@tarojs/taro';",
      "import type { Current } from '@tarojs/taro';",
      "import { type Config, useRouter } from '@tarojs/taro';",
    ].join('\n');
    expect(taroApiUses(source).map((u) => u.via)).toEqual([
      'import Taro',
      'import { useDidShow }',
      'import { navigateTo }',
      'import { useRouter }',
    ]);
  });
});

describe('privateOpenTypes', () => {
  it('reads combined open types, event props and the nickname input', () => {
    const source = [
      '<Button openType="getPhoneNumber|agreePrivacyAuthorization" onGetPhoneNumber={x} />',
      "<Button openType={'share'} />",
      '<Input type="nickname" />',
    ].join('\n');
    expect(privateOpenTypes(source).map((u) => u.name)).toEqual([
      'getPhoneNumber',
      'agreePrivacyAuthorization',
      'onGetPhoneNumber',
      'nickname',
    ]);
  });
});

describe('specifiersOf and isNutUi', () => {
  it('reads imports, re-exports, requires, dynamic imports and scss imports', () => {
    const source = [
      "import a from './a';",
      "export * from '@/b';",
      "import 'c.css';",
      "const d = require('d');",
      "const e = await import('e');",
      "@use '~@nutui/nutui-react-taro/dist/styles/variables';",
    ].join('\n');
    expect(specifiersOf(source).map((s) => s.specifier)).toEqual([
      './a',
      '@/b',
      'c.css',
      'd',
      'e',
      '~@nutui/nutui-react-taro/dist/styles/variables',
    ]);
  });

  it('knows NutUI however it is spelt', () => {
    expect(isNutUi('@nutui/nutui-react-taro')).toBe(true);
    expect(isNutUi('~@nutui/icons-react-taro')).toBe(true);
    expect(isNutUi('../node_modules/@nutui/x')).toBe(true);
    expect(isNutUi('@/ui/popup')).toBe(false);
  });
});

describe('urlLiterals', () => {
  it('reads page and API paths, without the query', () => {
    const source = [
      "openPage('/pages/product/index?id=1');",
      'const u = `packages/order/cashier/index?orderId=${id}`;',
      "fetchIt('/api/v1/orders/:id');",
      "const img = '/static/pages.png';",
    ].join('\n');
    expect(urlLiterals(source).map((u) => u.url)).toEqual([
      '/pages/product/index',
      'packages/order/cashier/index',
      '/api/v1/orders/:id',
    ]);
  });
});

describe('the manifest readers', () => {
  const manifest = {
    pages: ['pages/home/index'],
    subPackages: [{ root: 'packages/order/', pages: ['checkout/index'] }],
    tabBar: { list: [{ pagePath: 'pages/home/index', text: '首页' }] },
    requiredPrivateInfos: ['chooseAddress'],
  };

  it('joins sub-package pages to their root', () => {
    expect(registeredPages(manifest)).toEqual([
      { path: 'pages/home/index', root: null },
      { path: 'packages/order/checkout/index', root: 'packages/order' },
    ]);
  });

  it('reads the tab bar and the private-info declarations', () => {
    expect(tabBarPaths(manifest)).toEqual(['pages/home/index']);
    expect(requiredPrivateInfos(manifest)).toEqual(['chooseAddress']);
    expect(requiredPrivateInfos({})).toEqual([]);
  });

  it('names a page by its config file', () => {
    expect(pageOfConfigFile('packages/order/checkout/index.config.ts')).toBe(
      'packages/order/checkout/index',
    );
    expect(pageOfConfigFile('app.config.ts')).toBeNull();
    expect(pageOfConfigFile('features/x/index.config.ts')).toBeNull();
  });
});

describe('exportedInitializer', () => {
  it('returns the bracketed initializer, nested brackets included', () => {
    const source = "export const PRIVACY_APIS = [{ api: 'a', scopes: ['x'] }, 'b'] as const;";
    expect(exportedInitializer(source, 'PRIVACY_APIS')).toBe("[{ api: 'a', scopes: ['x'] }, 'b']");
  });

  it('returns null when there is no such export', () => {
    expect(exportedInitializer('const PRIVACY_APIS = [];', 'PRIVACY_APIS')).toBeNull();
  });
});
