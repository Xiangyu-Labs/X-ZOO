/**
 * The `mini` guard's mutations: for every rule, the smallest change to
 * `apps/mini` that breaks it, and the finding the guard must answer with.
 *
 * The shape follows `mutations.ts` (MUT-001): each edit is a literal
 * `search → replace` that must match **exactly once**, or a new file that must
 * not exist yet, applied to a scratch copy of `apps/mini` — never to the live
 * tree. A mutation whose anchor moved fails the run loudly instead of mutating
 * nothing; re-read the rule and update the strings, do not loosen the runner.
 *
 * Unlike MUT-001 these need no database: `src/checks/mini.mutations.test.ts`
 * runs the guard in-process over each copy, on every commit. A mutant is
 * killed when the guard reports a `fail` finding tagged with the mutation's
 * rule whose message matches `expect`. The unmutated copy is the baseline and
 * must have no failure at all.
 *
 * Anchors are kept to what is least likely to churn — the page manifest's
 * top-level lists (`app.pages.ts`), `app.config.ts`'s top-level keys, committed
 * config — and most mutants add a file instead of editing one, so stream work
 * on the pages does not break the catalogue.
 *
 * `UNBUILT_ROUTES` and `UNCATALOGUED_PAGES` are empty now that every catalogue
 * page is registered, so a stale entry cannot be produced from `apps/mini`
 * alone; the rule stays for the next page that lands in two steps.
 */
import type { MiniRule } from '../../src/checks/mini';

export type MiniEdit =
  | {
      /** Relative to `apps/mini`. */
      file: string;
      search: string;
      replace: string;
    }
  | {
      /** Relative to `apps/mini`; must not exist in the tree. */
      file: string;
      create: string;
    };

export interface MiniMutation {
  id: string;
  rule: MiniRule;
  /** What the mutant does, in one line. */
  summary: string;
  edits: readonly MiniEdit[];
  /** A `fail` finding tagged `[rule]` whose message matches this must appear. */
  expect: RegExp;
}

const APP_CONFIG = 'src/app.config.ts';
/** The page manifest `app.config.ts` builds `pages` and `subPackages` from. */
const APP_PAGES = 'src/app.pages.ts';
const SUBPACKAGES = 'export const SUB_PACKAGES: readonly SubPackage[] = [';
const PRIVATE_INFOS = 'requiredPrivateInfos: [';
const PAGE_CONFIG = "export default definePageConfig({ navigationBarTitleText: '变异' });\n";
const PAGE = 'export default function Mutant() {\n  return null;\n}\n';

export const MINI_MUTATIONS: readonly MiniMutation[] = [
  // --- [pages] -------------------------------------------------------------
  {
    id: 'page-without-source',
    rule: 'pages',
    summary: 'a sub-package registers a page that has no source file',
    edits: [
      {
        file: APP_PAGES,
        search: SUBPACKAGES,
        replace: `${SUBPACKAGES}{ root: 'packages/mutant', name: 'mutant', pages: ['gone/index'] },`,
      },
    ],
    expect: /registers packages\/mutant\/gone\/index, which has no src\//,
  },
  {
    id: 'page-not-registered',
    rule: 'pages',
    summary: 'a page file (config + component) that app.config.ts does not register',
    edits: [
      { file: 'src/packages/mutant/orphan/index.config.ts', create: PAGE_CONFIG },
      { file: 'src/packages/mutant/orphan/index.tsx', create: PAGE },
    ],
    expect: /is the page packages\/mutant\/orphan\/index, which app\.config\.ts does not register/,
  },
  {
    id: 'dev-page-outside-demo',
    rule: 'pages',
    summary: 'a dev-only page registered in a shipping sub-package',
    edits: [
      {
        file: APP_PAGES,
        search: SUBPACKAGES,
        replace: `${SUBPACKAGES}{ root: 'packages/dev', name: 'dev', pages: ['kit/index'] },`,
      },
      { file: 'src/packages/dev/kit/index.config.ts', create: PAGE_CONFIG },
      { file: 'src/packages/dev/kit/index.tsx', create: PAGE },
    ],
    expect: /registers the dev-only page packages\/dev\/kit\/index outside/,
  },
  {
    id: 'demo-imported',
    rule: 'pages',
    summary: 'shipping code imports from the demo sub-package',
    edits: [
      {
        file: 'src/features/mutant.ts',
        create: "export { default } from '@/subpackages/demo/pages/ui/index';\n",
      },
    ],
    expect: /imports @\/subpackages\/demo\/pages\/ui\/index: the dev-only sub-package/,
  },
  {
    id: 'tab-in-subpackage',
    rule: 'pages',
    summary: 'the tabBar lists a sub-package page',
    edits: [
      {
        file: APP_CONFIG,
        search: 'list: TAB_PAGES.map(',
        replace:
          "list: [{ pagePath: 'packages/order/checkout/index', text: '结算' }, ...TAB_PAGES].map(",
      },
    ],
    expect: /tabBar lists packages\/order\/checkout\/index, which is not a main-package page/,
  },

  // --- [routes] ------------------------------------------------------------
  {
    id: 'catalogue-page-unregistered',
    rule: 'routes',
    summary: 'a built catalogue page (product) drops out of the page manifest',
    edits: [
      {
        file: APP_PAGES,
        search: "  'pages/product/index',\n  'pages/login/index',",
        replace: "  'pages/product-gone/index',\n  'pages/login/index',",
      },
    ],
    expect: /product → pages\/product\/index, which app\.config\.ts does not register/,
  },
  {
    id: 'page-without-route-key',
    rule: 'routes',
    summary: 'a registered page that no storefront route key names',
    edits: [
      {
        file: APP_PAGES,
        search: SUBPACKAGES,
        replace: `${SUBPACKAGES}{ root: 'packages/mutant', name: 'mutant', pages: ['extra/index'] },`,
      },
      { file: 'src/packages/mutant/extra/index.config.ts', create: PAGE_CONFIG },
      { file: 'src/packages/mutant/extra/index.tsx', create: PAGE },
    ],
    expect: /registers packages\/mutant\/extra\/index, which no storefront route key names/,
  },
  {
    id: 'tab-keys-differ',
    rule: 'routes',
    summary: "a TAB_PAGES key that is not the catalogue's tab key",
    edits: [{ file: 'src/platform/tab-pages.ts', search: "key: 'me'", replace: "key: 'mine'" }],
    expect: /TAB_PAGES keys \[home, category, cart, mine\] are not the catalogue's tab keys/,
  },

  // --- [platform] ----------------------------------------------------------
  {
    id: 'taro-navigate-outside-platform',
    rule: 'platform',
    summary: 'a feature holds Taro and navigates by itself',
    edits: [
      {
        file: 'src/features/mutant.ts',
        create:
          "import Taro from '@tarojs/taro';\n\nexport const go = () => Taro.navigateTo({ url: '/pages/cart/index' });\n",
      },
    ],
    expect: /Taro\.navigateTo outside src\/platform\//,
  },
  {
    id: 'wx-request-outside-platform',
    rule: 'platform',
    summary: 'a feature calls wx.request directly',
    edits: [
      {
        file: 'src/features/mutant.ts',
        create:
          "declare const wx: { request(options: object): void };\n\nexport const leak = () => wx.request({ url: '' });\n",
      },
    ],
    expect: /wx\.request outside src\/platform\//,
  },
  {
    id: 'named-platform-import',
    rule: 'platform',
    summary: 'a page imports switchTab from @tarojs/taro',
    edits: [
      {
        file: 'src/features/mutant.ts',
        create:
          "import { switchTab, useDidShow } from '@tarojs/taro';\n\nexport { switchTab, useDidShow };\n",
      },
    ],
    expect: /import \{ switchTab \} outside src\/platform\//,
  },
  {
    id: 'phone-button-outside-platform',
    rule: 'platform',
    summary: 'a page renders its own getPhoneNumber button',
    edits: [
      {
        file: 'src/features/mutant.tsx',
        create:
          'import { Button } from \'@tarojs/components\';\n\nexport const Phone = () => <Button openType="getPhoneNumber|agreePrivacyAuthorization" />;\n',
      },
    ],
    expect: /openType="getPhoneNumber\|agreePrivacyAuthorization" outside src\/platform\//,
  },
  {
    id: 'get-user-profile',
    rule: 'platform',
    summary: 'the platform asks for the profile the retired way',
    edits: [
      {
        file: 'src/platform/mutant.ts',
        create:
          "import Taro from '@tarojs/taro';\n\nexport const who = () => Taro.getUserProfile({ desc: '完善资料' });\n",
      },
    ],
    expect: /Taro\.getUserProfile: WeChat no longer hands out profiles this way/,
  },

  // --- [nutui] -------------------------------------------------------------
  {
    id: 'nutui-in-feature',
    rule: 'nutui',
    summary: 'a feature imports NutUI (removed)',
    edits: [
      {
        file: 'src/features/mutant.tsx',
        create:
          "import NutToast from '@nutui/nutui-react-taro/dist/es/packages/toast';\n\nexport { NutToast };\n",
      },
    ],
    expect: /imports @nutui\/nutui-react-taro\/dist\/es\/packages\/toast; NutUI is not used/,
  },
  {
    id: 'nutui-in-kit',
    rule: 'nutui',
    summary: "the kit's stylesheet pulls in NutUI's variables (NutUI was removed)",
    edits: [
      {
        file: 'src/ui/mutant.scss',
        create: "@import '~@nutui/nutui-react-taro/dist/styles/variables';\n",
      },
    ],
    expect: /imports ~@nutui\/nutui-react-taro\/dist\/styles\/variables; NutUI is not used/,
  },

  // --- [privacy] -----------------------------------------------------------
  {
    id: 'private-info-undeclared',
    rule: 'privacy',
    summary: 'the platform calls getLocation, which requiredPrivateInfos does not declare',
    edits: [
      {
        file: 'src/platform/mutant.ts',
        create:
          "import Taro from '@tarojs/taro';\n\nexport const where = () => Taro.getLocation({ type: 'gcj02' });\n",
      },
    ],
    expect: /calls getLocation, which app\.config\.ts does not declare in requiredPrivateInfos/,
  },
  {
    id: 'private-info-overdeclared',
    rule: 'privacy',
    summary: 'requiredPrivateInfos declares a location API the shop does not use',
    edits: [
      {
        file: APP_CONFIG,
        search: PRIVATE_INFOS,
        replace: `${PRIVATE_INFOS}'getFuzzyLocation', `,
      },
    ],
    expect:
      /declares getFuzzyLocation in requiredPrivateInfos; this shop declares only chooseAddress/,
  },
  {
    id: 'privacy-apis-incomplete',
    rule: 'privacy',
    summary: 'the platform copies to the clipboard, and PRIVACY_APIS does not list it',
    edits: [
      // platform/clipboard.ts copies; the list forgets it.
      {
        file: 'src/platform/privacy.ts',
        search: "  'setClipboardData',\n] as const;",
        replace: '] as const;',
      },
    ],
    expect: /uses setClipboardData, which PRIVACY_APIS \(platform\/privacy\.ts\) does not list/,
  },

  // --- [retired] -----------------------------------------------------------
  {
    id: 'retired-page-path',
    rule: 'retired',
    summary: 'a 砍价 page comes back as a sub-package page',
    edits: [
      {
        file: APP_PAGES,
        search: SUBPACKAGES,
        replace: `${SUBPACKAGES}{ root: 'packages/promo-old', name: 'promo-old', pages: ['bargain/index'] },`,
      },
    ],
    expect: /packages\/promo-old\/bargain\/index is a URL for the retired 砍价/,
  },
  {
    id: 'retired-url-literal',
    rule: 'retired',
    summary: 'a feature links to a 秒杀 page',
    edits: [
      {
        file: 'src/features/mutant.ts',
        create: "export const to = '/packages/promo/seckill-detail/index?id=1';\n",
      },
    ],
    expect: /\/packages\/promo\/seckill-detail\/index is a URL for the retired 秒杀/,
  },

  // --- [config] ------------------------------------------------------------
  {
    id: 'url-check-off',
    rule: 'config',
    summary: 'domain checking is switched off in the committed project config',
    edits: [
      { file: 'project.config.json', search: '"urlCheck": true', replace: '"urlCheck": false' },
    ],
    expect: /setting\.urlCheck must stay true/,
  },
  {
    id: 'appid-committed',
    rule: 'config',
    summary: "someone's own AppID (not the shop's) is committed to a shared env file",
    edits: [
      {
        file: '.env.production',
        search: 'TARO_APP_ID="wx4f4b772125e155ed"',
        replace: 'TARO_APP_ID="wx0123456789abcdef"',
      },
    ],
    expect: /commits the AppID wx0123456789abcdef, which is not the shop's/,
  },
  {
    id: 'http-origin-committed',
    rule: 'config',
    summary: 'a committed env file points the API at plain http',
    edits: [{ file: '.env.test', create: 'TARO_APP_API_ORIGIN="http://192.168.1.10:25000"\n' }],
    expect: /commits a plain-http API origin http:\/\/192\.168\.1\.10:25000/,
  },
  {
    id: 'appid-in-project-config',
    rule: 'config',
    summary: "the committed project config names someone's own AppID",
    edits: [
      {
        file: 'project.config.json',
        search: '"appid": "wx4f4b772125e155ed"',
        replace: '"appid": "wx0123456789abcdef"',
      },
    ],
    expect: /appid is wx0123456789abcdef; commit only the shop's/,
  },

  // --- [credentials] -------------------------------------------------------
  {
    id: 'upload-key-in-app',
    rule: 'credentials',
    summary: "miniprogram-ci's upload key is dropped into the app directory",
    edits: [
      {
        file: 'private.wx4f4b772125e155ed.key',
        create: '-----BEGIN RSA PRIVATE KEY-----\nmutant\n-----END RSA PRIVATE KEY-----\n',
      },
    ],
    expect: /private\.wx4f4b772125e155ed\.key: \[credentials\] is a miniprogram-ci upload key/,
  },
  {
    id: 'appsecret-in-env',
    rule: 'credentials',
    summary: 'an AppSecret is put in a local env file, where Taro would inline it',
    edits: [
      // Built, not written out, so this file itself holds no 32-hex token.
      {
        file: '.env.development.local',
        create: `TARO_APP_SECRET="${'0123456789abcdef'.repeat(2)}"\n`,
      },
    ],
    expect: /\.env\.development\.local:1: \[credentials\] holds a 32-hex-digit token \(0123…\)/,
  },
  {
    id: 'appsecret-in-source',
    rule: 'credentials',
    summary: 'an AppSecret-shaped constant appears in the platform code',
    edits: [
      {
        file: 'src/platform/mutant-secret.ts',
        create: `export const APP_SECRET = '${'fedcba9876543210'.repeat(2)}';\n`,
      },
    ],
    expect: /src\/platform\/mutant-secret\.ts:1: \[credentials\] holds a 32-hex-digit token/,
  },
];
