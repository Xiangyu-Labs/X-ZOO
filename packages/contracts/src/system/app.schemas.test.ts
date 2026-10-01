import { describe, expect, it } from 'vitest';
import { subscribeScene } from '../wechat-oa/schemas';
import {
  appAppearanceDefaults,
  appDisplayDefaults,
  appPublicConfig,
  appSubscribeScene,
  appTabKey,
  hexColor,
  webviewDomain,
} from './app.schemas';

/**
 * The shapes behind `GET /api/v1/app/config` (SYS-015). The config group
 * validates colours with this same `hexColor`, so what is refused here is
 * refused on the settings screen too.
 */
describe('SYS-015 — hexColor', () => {
  it.each(['#E93323', '#e93323', '#000000', '#FfFfFf'])('accepts %s', (value) => {
    expect(hexColor.safeParse(value).success).toBe(true);
  });

  it.each([
    ['a colour name', 'red'],
    ['three digits', '#F00'],
    ['eight digits', '#E93323FF'],
    ['no #', 'E93323'],
    ['a non-hex digit', '#E9332G'],
    ['a CSS keyword', 'transparent'],
    ['surrounding space', ' #E93323'],
    ['empty', ''],
  ])('refuses %s', (_label, value) => {
    expect(hexColor.safeParse(value).success).toBe(false);
  });
});

describe('SYS-015 — appearance defaults', () => {
  it('are a valid appearance, with the four fixed tabs in order', () => {
    const parsed = appPublicConfig.shape.appearance.parse(appAppearanceDefaults);
    expect(parsed.tabBar.items.map((item) => item.key)).toEqual(appTabKey.options);
    expect(parsed.tabBar.items.every((item) => item.label.length > 0)).toBe(true);
  });

  it('refuses a tab bar with a tab missing', () => {
    const appearance = {
      ...appAppearanceDefaults,
      tabBar: {
        ...appAppearanceDefaults.tabBar,
        items: appAppearanceDefaults.tabBar.items.slice(1),
      },
    };
    expect(appPublicConfig.shape.appearance.safeParse(appearance).success).toBe(false);
  });
});

describe('SYS-015 — display defaults', () => {
  it('show every optional part, the product poster included', () => {
    const parsed = appPublicConfig.shape.display.parse(appDisplayDefaults);
    expect(parsed.productPoster).toBe(true);
    expect(Object.values(parsed).every(Boolean)).toBe(true);
  });
});

describe('subscribeTemplates', () => {
  it('has one key per subscribe scene, camelCased', () => {
    const camel = (scene: string) => scene.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase());
    expect(Object.keys(appPublicConfig.shape.subscribeTemplates.shape).sort()).toEqual(
      subscribeScene.options.map(camel).sort(),
    );
  });
});

describe('SYS-018 — subscribe scenes', () => {
  it('has one key per scene the mini-program asks from, and caps each at three ids', () => {
    const shape = appPublicConfig.shape.subscribeScenes;
    expect(Object.keys(shape.shape).sort()).toEqual([...appSubscribeScene.options].sort());
    const four = ['a', 'b', 'c', 'd'];
    expect(shape.shape.checkout.safeParse(four).success).toBe(false);
    expect(shape.shape.checkout.safeParse(four.slice(0, 3)).success).toBe(true);
    expect(shape.shape.checkout.safeParse(['']).success).toBe(false);
  });
});

describe('SYS-019 — webview domains', () => {
  it.each(['shop.example.com', 'a.b.cn', 'xn--fiqs8s.com'])('accepts %s', (value) => {
    expect(webviewDomain.safeParse(value).success).toBe(true);
  });

  it.each([
    ['a scheme', 'https://shop.example.com'],
    ['a path', 'shop.example.com/x'],
    ['a port', 'shop.example.com:8443'],
    ['upper case', 'Shop.Example.com'],
    ['a bare label', 'localhost'],
    ['an IP address', '192.168.1.20'],
    ['empty', ''],
  ])('refuses %s', (_label, value) => {
    expect(webviewDomain.safeParse(value).success).toBe(false);
  });
});

describe('splash ad', () => {
  it('takes a LinkTarget, not a path', () => {
    const splash = appPublicConfig.shape.splashAd;
    const base = { enabled: true, imageUrl: null, seconds: 3 };
    expect(splash.safeParse({ ...base, link: { kind: 'product', id: '12' } }).success).toBe(true);
    expect(splash.safeParse({ ...base, link: null }).success).toBe(true);
    expect(splash.safeParse({ ...base, link: '/pages/goods_details/index?id=12' }).success).toBe(
      false,
    );
  });
});
