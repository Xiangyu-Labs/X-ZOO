import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appAppearanceDefaults,
  appDisplayDefaults,
  appPublicConfig,
  appSubscribeScene,
} from '@shop/contracts/system/app.schemas';
import { subscribeScene } from '@shop/contracts/wechat-oa/schemas';
import { configValues } from '@shop/db/schema/system';
import { createTestCtx, type TestCtx } from '@shop/testing';
import { allConfigGroups } from '../kernel/config-registry';
import { anonymousActor, type Ctx } from '../kernel/context';
import { DomainError } from '../kernel/errors';
import { wechatOaStorefront } from '../wechat-oa';
import { appConfigGet, appConfigSourceGroups, subscribeScenesOf } from './app-config.service';
import { configSave, describeGroup } from './config.service';
import './index';
// The bootstrap every request runs: without it neither `wechat-oa` nor `user`
// has registered its reader, and this would test a process no deployment runs.
import '../domains.gen';

/**
 * `GET /api/v1/app/config` against a real PostgreSQL and Redis.
 *
 * SYS-014 — nothing secret, in any registered group, reaches the payload.
 * SYS-015 — the appearance group answers with every field defaulted, serves
 *           what the operator saved, and refuses a colour that is not `#RRGGBB`.
 * SYS-016 — a save to any source group drops the cache and moves `version` at
 *           once, and it serves the site's values the operator saved.
 */

let harness: TestCtx;

const NOW = '2026-09-23T08:00:00.000Z';

const anonymous = (): Ctx => harness.ctx.as(anonymousActor);

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  throw new Error('expected a DomainError');
}

/** Saves through the settings screen's own path, one second after the last save. */
async function save(group: string, values: Record<string, unknown>): Promise<void> {
  harness.clock.advance(1_000);
  await configSave(harness.ctx, { group }, { values });
}

beforeAll(async () => {
  harness = await createTestCtx({ now: NOW });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(async () => {
  await harness.db.truncateAll();
  await harness.redis.flushdb();
  harness.clock.set(NOW);
  for (const group of allConfigGroups()) await harness.ctx.config.invalidate(group.group);
});

describe('SYS-014 — the app config leaks nothing', () => {
  it('answers a request with no session, and the answer matches the contract', async () => {
    expect(anonymous().actor.kind).toBe('anonymous');
    const payload = await appConfigGet(anonymous());
    expect(appPublicConfig.safeParse(payload).success).toBe(true);
    expect(payload.version).toBe('0');
  });

  it('cannot leak any secret in any registered group', async () => {
    const markers: string[] = [];
    const rows: { group: string; key: string; value: unknown; updatedAt: Date }[] = [];
    for (const group of allConfigGroups()) {
      for (const field of describeGroup(group).fields) {
        if (field.secret !== true) continue;
        const marker = `LEAKED-${group.group}-${field.key}-${markers.length}`;
        markers.push(marker);
        rows.push({
          group: group.group,
          key: field.key,
          value: marker,
          updatedAt: harness.ctx.clock.now(),
        });
      }
    }
    expect(markers.length).toBeGreaterThan(5);

    await harness.ctx.db.insert(configValues).values(rows);
    for (const group of allConfigGroups()) await harness.ctx.config.invalidate(group.group);

    const serialised = JSON.stringify(await appConfigGet(anonymous()));
    for (const marker of markers) expect(serialised).not.toContain(marker);
  });
});

describe('SYS-015 — 小程序外观', () => {
  it('answers a fresh install with every appearance default', async () => {
    const { appearance } = await appConfigGet(anonymous());
    expect(appearance).toEqual(appAppearanceDefaults);
    expect(appearance.tabBar.items.map((item) => item.key)).toEqual([
      'home',
      'category',
      'cart',
      'me',
    ]);
  });

  it('serves the theme and the tab bar the operator saved', async () => {
    await save('storefront-appearance', {
      primaryColor: '#1677ff',
      priceColor: '#FF4D4F',
      radius: 'large',
      tabBarColor: '#666666',
      tabBarSelectedColor: '#1677FF',
      tabBarBackgroundColor: '#FAFAFA',
      tabHomeLabel: '逛逛',
      tabHomeIcon: '/uploads/attach/home.png',
      tabHomeSelectedIcon: '/uploads/attach/home-on.png',
      tabMeLabel: '会员',
    });

    const { appearance } = await appConfigGet(anonymous());
    expect(appearance.theme).toEqual({
      primaryColor: '#1677ff',
      // Derived from the primary: dark text on this light blue.
      primaryContrastColor: '#1A1A1A',
      accentColor: null,
      priceColor: '#FF4D4F',
      radius: 'large',
    });
    expect(appearance.tabBar).toEqual({
      color: '#666666',
      selectedColor: '#1677FF',
      backgroundColor: '#FAFAFA',
      items: [
        {
          key: 'home',
          label: '逛逛',
          iconUrl: '/uploads/attach/home.png',
          selectedIconUrl: '/uploads/attach/home-on.png',
        },
        { key: 'category', label: '分类', iconUrl: null, selectedIconUrl: null },
        { key: 'cart', label: '购物车', iconUrl: null, selectedIconUrl: null },
        { key: 'me', label: '会员', iconUrl: null, selectedIconUrl: null },
      ],
    });
  });

  it('shows every optional part of 分类 and 商品详情 until the operator switches one off', async () => {
    expect((await appConfigGet(anonymous())).display).toEqual(appDisplayDefaults);
    expect(Object.values(appDisplayDefaults).every(Boolean)).toBe(true);

    await save('storefront-appearance', {
      showCategorySubcategories: false,
      showProductRecommendations: false,
    });
    expect((await appConfigGet(anonymous())).display).toEqual({
      categorySubcategories: false,
      productReviews: true,
      productRecommendations: false,
      productServiceTags: true,
      productPoster: true,
    });
  });

  it('offers the product poster until the operator switches it off', async () => {
    expect((await appConfigGet(anonymous())).display.productPoster).toBe(true);
    await save('storefront-appearance', { showProductPoster: false });
    expect((await appConfigGet(anonymous())).display).toEqual({
      ...appDisplayDefaults,
      productPoster: false,
    });
  });

  it('serves the accent colour, and a blanked one as none', async () => {
    await save('storefront-appearance', { accentColor: '#FF7E00' });
    expect((await appConfigGet(anonymous())).appearance.theme.accentColor).toBe('#FF7E00');
    await save('storefront-appearance', { accentColor: '' });
    expect((await appConfigGet(anonymous())).appearance.theme.accentColor).toBeNull();
  });

  it('falls back to the default label when the operator blanks one', async () => {
    // Clearing the box on the settings screen must not leave a tab with no text.
    await save('storefront-appearance', { tabCartLabel: '   ', tabCategoryLabel: '' });
    const { items } = (await appConfigGet(anonymous())).appearance.tabBar;
    expect(items.find((item) => item.key === 'cart')?.label).toBe('购物车');
    expect(items.find((item) => item.key === 'category')?.label).toBe('分类');
  });

  it.each([
    ['a colour name', { primaryColor: 'red' }],
    ['a three-digit hex', { priceColor: '#F00' }],
    ['a CSS keyword', { tabBarBackgroundColor: 'transparent' }],
    ['a hex without its #', { tabBarColor: '282828' }],
    ['an eight-digit hex', { tabBarSelectedColor: '#E93323FF' }],
    ['an accent colour name', { accentColor: 'orange' }],
    ['a radius off the scale', { radius: 'huge' }],
    ['a label too long for the bar', { tabHomeLabel: '这是一个很长的首页标签' }],
  ])('refuses %s, and writes nothing', async (_label, values) => {
    expect(
      await code(configSave(harness.ctx, { group: 'storefront-appearance' }, { values })),
    ).toBe('VALIDATION_FAILED');
    expect(await harness.ctx.db.select().from(configValues)).toHaveLength(0);
    expect((await appConfigGet(anonymous())).appearance).toEqual(appAppearanceDefaults);
  });
});

describe('SYS-016 — one payload, always current', () => {
  it('is built from exactly the groups that drop its cache', () => {
    expect([...appConfigSourceGroups()].sort()).toEqual([
      'payment',
      'site',
      'sms',
      'storefront-appearance',
      'storefront-auth',
      'wechat',
      'wechat-mini',
      'wechat-oa',
      'wechat-oa-runtime',
    ]);
  });

  it.each([
    ['site', { siteName: '新店名' }],
    ['wechat-mini', { contactPhone: '13800000000' }],
    ['storefront-appearance', { primaryColor: '#000000' }],
    ['wechat-oa-runtime', { subscribeOrderPay: 'tmpl-pay-1' }],
    ['storefront-auth', { requirePhoneForWechat: false }],
  ] as const)('drops the cache and moves the version when %s is saved', async (group, values) => {
    const before = await appConfigGet(anonymous());

    // Proves the next read is served from the cache: a write behind the
    // service's back is not seen…
    await harness.ctx.db
      .insert(configValues)
      .values({ group: 'site', key: 'siteName', value: '后门写入', updatedAt: new Date(0) });
    await harness.ctx.config.invalidate('site');
    expect((await appConfigGet(anonymous())).name).toBe(before.name);

    // …until a save through the real path lands in any source group.
    await save(group, values);
    const after = await appConfigGet(anonymous());
    expect(after.version).not.toBe(before.version);
    expect(after.version).toBe(String(harness.clock.nowMs()));
    if (group !== 'site') expect(after.name).toBe('后门写入');
  });

  it('leaves the cache alone when a group it does not read is saved', async () => {
    const before = await appConfigGet(anonymous());
    await harness.ctx.db
      .insert(configValues)
      .values({ group: 'site', key: 'siteName', value: '后门写入', updatedAt: new Date(0) });
    await harness.ctx.config.invalidate('site');

    await save('map', { defaultCity: '杭州' });
    const after = await appConfigGet(anonymous());
    expect(after.version).toBe(before.version);
    expect(after.name).toBe(before.name);
  });

  it('carries the same subscribe ids as GET /wechat/subscribe-templates, every scene', async () => {
    await save('wechat-oa-runtime', {
      subscribeOrderCreate: '',
      subscribeOrderPay: ' tmpl-pay-1 , tmpl-pay-2,tmpl-pay-1 ',
      subscribeOrderUnpaid: 'tmpl-unpaid',
      subscribeOrderShip: 'tmpl-ship',
      subscribeRefund: 'tmpl-refund,,',
    });

    const { subscribeTemplates } = await appConfigGet(anonymous());
    expect(subscribeTemplates).toEqual({
      orderCreate: [],
      orderPay: ['tmpl-pay-1', 'tmpl-pay-2'],
      orderUnpaid: ['tmpl-unpaid'],
      orderShip: ['tmpl-ship'],
      refund: ['tmpl-refund'],
    });

    // Every scene the per-scene route knows has its key here, and agrees.
    const keyOf = (scene: string) => scene.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase());
    for (const scene of subscribeScene.options) {
      const perScene = await wechatOaStorefront.subscribeTemplatesFor(harness.ctx, { scene });
      expect(subscribeTemplates[keyOf(scene) as keyof typeof subscribeTemplates], scene).toEqual(
        perScene.templateIds,
      );
    }
  });

  it('says whether a first WeChat sign-in will ask for a phone', async () => {
    expect((await appConfigGet(anonymous())).auth.wechatRequiresPhone).toBe(true);
    await save('storefront-auth', { requirePhoneForWechat: false });
    expect((await appConfigGet(anonymous())).auth.wechatRequiresPhone).toBe(false);
  });

  it('serves the site values the operator saved', async () => {
    await save('site', {
      siteName: '示例商城',
      logo: '/uploads/a.png',
      logoSquare: '/uploads/sq.png',
      shareTitle: '好货不贵',
      shareImage: '/uploads/share.png',
      contactPhone: '400-000-0000',
      splashEnabled: true,
      splashImage: '/uploads/adv.png',
    });
    await save('wechat-mini', { enabled: true, contactType: 'mini-program' });

    const app = await appConfigGet(anonymous());
    expect(app).toMatchObject({
      name: '示例商城',
      logo: { main: '/uploads/a.png', login: null, square: '/uploads/sq.png', favicon: null },
      share: { title: '好货不贵', synopsis: '', image: '/uploads/share.png' },
      support: { kind: 'mini-program', phone: '400-000-0000', qrcodeUrl: null },
      auth: { wechatOa: false, wechatMini: false, phone: false },
      payments: { wechat: false },
      splashAd: { enabled: true, imageUrl: '/uploads/adv.png', link: null },
    });
  });
});

describe('SYS-017 — the server clock rides outside the version', () => {
  it('stamps serverTime per request, from the cache too, without moving the version', async () => {
    const first = await appConfigGet(anonymous());
    expect(first.serverTime).toBe(NOW);

    harness.clock.advance(30_000);
    const second = await appConfigGet(anonymous());
    expect(second.serverTime).toBe(harness.clock.now().toISOString());
    expect(second.version).toBe(first.version);

    // The cached copy never holds a clock of its own.
    const cached = JSON.parse((await harness.redis.get('app:config:v3')) ?? '{}') as object;
    expect(cached).not.toHaveProperty('serverTime');
  });
});

describe('SYS-018 — subscribe scenes are built on the server', () => {
  it('asks each tap for its templates, shipping first, deduplicated, at most three', async () => {
    await save('wechat-oa-runtime', {
      subscribeOrderCreate: 'tmpl-create',
      subscribeOrderPay: 'tmpl-pay, tmpl-ship',
      subscribeOrderShip: 'tmpl-ship, tmpl-delivered',
      subscribeRefund: 'tmpl-refund-1, tmpl-refund-2, tmpl-refund-3, tmpl-refund-4',
    });

    const { subscribeScenes } = await appConfigGet(anonymous());
    const order = ['tmpl-ship', 'tmpl-delivered', 'tmpl-pay'];
    expect(subscribeScenes).toEqual({
      checkout: order,
      groupbuyCheckout: order,
      presaleCheckout: order,
      refundApply: ['tmpl-refund-1', 'tmpl-refund-2', 'tmpl-refund-3'],
      returnShipment: ['tmpl-refund-1', 'tmpl-refund-2', 'tmpl-refund-3'],
    });
    expect(Object.keys(subscribeScenes).sort()).toEqual([...appSubscribeScene.options].sort());
  });

  it('answers [] for every tap when no template is set', async () => {
    const { subscribeScenes } = await appConfigGet(anonymous());
    for (const scene of appSubscribeScene.options) expect(subscribeScenes[scene]).toEqual([]);
  });

  it('skips blank ids and fills from the next list', () => {
    expect(
      subscribeScenesOf({
        orderCreate: ['c'],
        orderPay: [' ', 'p'],
        orderUnpaid: [],
        orderShip: [],
        refund: [''],
      }),
    ).toMatchObject({ checkout: ['p', 'c'], refundApply: [] });
  });

  it('asks for the 未付款提醒 after shipping and before payment, so creation is the one cut', async () => {
    await save('wechat-oa-runtime', {
      subscribeOrderCreate: 'tmpl-create',
      subscribeOrderPay: 'tmpl-pay',
      subscribeOrderUnpaid: 'tmpl-unpaid',
      subscribeOrderShip: 'tmpl-ship',
    });

    const { subscribeScenes, subscribeTemplates } = await appConfigGet(anonymous());
    const order = ['tmpl-ship', 'tmpl-unpaid', 'tmpl-pay'];
    expect(subscribeScenes).toMatchObject({
      checkout: order,
      groupbuyCheckout: order,
      presaleCheckout: order,
    });
    expect(subscribeTemplates.orderUnpaid).toEqual(['tmpl-unpaid']);
  });
});

describe('SYS-019 — web-view domains', () => {
  it('serves the operator list lower-cased and deduplicated, one per line or comma', async () => {
    expect((await appConfigGet(anonymous())).webviewDomains).toEqual([]);
    await save('wechat-mini', {
      webviewDomains: 'Shop.Example.com\n h5.example.com, shop.example.com\n\n',
    });
    expect((await appConfigGet(anonymous())).webviewDomains).toEqual([
      'shop.example.com',
      'h5.example.com',
    ]);
  });

  it.each([
    ['a scheme', 'https://shop.example.com'],
    ['a path', 'shop.example.com/pay'],
    ['a port', 'shop.example.com:8443'],
    ['a wildcard', '*.example.com'],
  ])('refuses %s, and writes nothing', async (_label, webviewDomains) => {
    expect(
      await code(configSave(harness.ctx, { group: 'wechat-mini' }, { values: { webviewDomains } })),
    ).toBe('VALIDATION_FAILED');
    expect(await harness.ctx.db.select().from(configValues)).toHaveLength(0);
  });
});

describe('SYS-020 — the splash taps through a LinkTarget', () => {
  const on = { splashEnabled: true, splashImage: '/uploads/adv.png' };

  it('serves the stored LinkTarget ahead of the legacy path', async () => {
    await save('site', {
      ...on,
      splashLink: '/pages/goods_details/index?id=12',
      splashLinkTarget: { kind: 'product', id: '12' },
    });
    expect((await appConfigGet(anonymous())).splashAd.link).toEqual({ kind: 'product', id: '12' });
  });

  it('falls back to an https legacy link as a web-view, and to none for a uni-app path', async () => {
    await save('site', { ...on, splashLink: 'https://shop.example.com/sale' });
    expect((await appConfigGet(anonymous())).splashAd.link).toEqual({
      kind: 'webview',
      url: 'https://shop.example.com/sale',
    });

    await save('site', { ...on, splashLink: '/pages/goods_details/index?id=12' });
    expect((await appConfigGet(anonymous())).splashAd.link).toBeNull();
  });

  it('refuses a LinkTarget that does not parse, and writes nothing', async () => {
    expect(
      await code(
        configSave(
          harness.ctx,
          { group: 'site' },
          { values: { splashLinkTarget: { kind: 'route', to: { route: 'nowhere', params: {} } } } },
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(await harness.ctx.db.select().from(configValues)).toHaveLength(0);
  });
});
