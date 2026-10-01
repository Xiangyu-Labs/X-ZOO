import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  decodeScene,
  encodeScene,
  SCENE_MAX_BYTES,
  storefrontRoute,
  storefrontRouteDef,
  storefrontRouteKey,
  storefrontRouteKeys,
  storefrontRoutes,
  toMiniPath,
  type StorefrontRoute,
  type StorefrontRouteKey,
  type StorefrontRouteParams,
} from './storefront-routes';

const MAX_ID = '9223372036854775807'; // 19 digits, the largest bigint id

const miniCodeKeys = storefrontRouteKeys.filter((key) => storefrontRouteDef(key).miniCode);

describe('the catalogue', () => {
  it('gives every key its own path', () => {
    const paths = storefrontRouteKeys.map((key) => storefrontRoutes[key].path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('writes paths the way the mini-program config does: no leading slash, no query', () => {
    for (const key of storefrontRouteKeys) {
      expect(storefrontRoutes[key].path, key).toMatch(/^(pages|packages)\/[a-z0-9/-]+\/index$/);
    }
  });

  it('keeps tab pages in the main package', () => {
    for (const key of storefrontRouteKeys.filter((k) => storefrontRouteDef(k).tab)) {
      expect(storefrontRoutes[key].path, key).toMatch(/^pages\//);
    }
  });

  it('gives each mini-code key one `id` param or none, so its scene fits in 32 bytes', () => {
    expect(miniCodeKeys.sort()).toEqual(
      [
        'article',
        'couponCenter',
        'groupbuy',
        'groupbuyTeam',
        'home',
        'page',
        'presale',
        'product',
      ].sort(),
    );
    for (const key of miniCodeKeys) {
      const params = storefrontRoutes[key].params;
      const empty = params.safeParse({}).success;
      const withId = params.safeParse({ id: MAX_ID }).success;
      expect(empty !== withId, key).toBe(true);
    }
  });

  it('has the two pages added on 2026-09-23, linkable and without params', () => {
    expect(storefrontRoutes.myReviews).toMatchObject({
      path: 'packages/account/reviews/index',
      share: 'none',
      linkable: true,
    });
    expect(storefrontRoutes.myGroupbuys).toMatchObject({
      path: 'packages/promo/my-groupbuys/index',
      share: 'none',
      linkable: true,
    });
    expect(storefrontRoute.safeParse({ route: 'myReviews', params: {} }).success).toBe(true);
    expect(storefrontRoute.safeParse({ route: 'myGroupbuys', params: { id: '1' } }).success).toBe(
      false,
    );
  });
});

describe('storefrontRoute', () => {
  it('parses a known key with valid params', () => {
    expect(storefrontRoute.parse({ route: 'product', params: { id: '42' } })).toEqual({
      route: 'product',
      params: { id: '42' },
    });
    expect(storefrontRoute.parse({ route: 'orderList', params: { tab: 'unpaid' } })).toEqual({
      route: 'orderList',
      params: { tab: 'unpaid' },
    });
  });

  it.each([
    ['an unknown key', { route: 'nowhere', params: {} }],
    ['a path instead of a key', { route: 'pages/index/index', params: {} }],
    ['no params', { route: 'home' }],
    ['a missing required param', { route: 'product', params: {} }],
    ['an id that is not a decimal string', { route: 'product', params: { id: '0x1' } }],
    ['a numeric id', { route: 'product', params: { id: 42 } }],
    ['a param the key does not take', { route: 'product', params: { id: '1', from: 'x' } }],
    ['an enum value outside the enum', { route: 'orderList', params: { tab: 'everything' } }],
    ['an agreement that does not exist', { route: 'agreement', params: { key: 'terms' } }],
    ['a plain-http webview', { route: 'webview', params: { url: 'http://shop.example/a' } }],
    ['an extra top-level field', { route: 'home', params: {}, path: 'pages/index/index' }],
  ])('refuses %s', (_label, value) => {
    expect(storefrontRoute.safeParse(value).success).toBe(false);
  });

  it('has a zod enum of exactly the catalogue keys', () => {
    expect(storefrontRouteKey.options).toEqual(Object.keys(storefrontRoutes));
    expect(storefrontRouteKey.safeParse('nowhere').success).toBe(false);
  });

  it('types params per key', () => {
    expectTypeOf<StorefrontRouteParams<'product'>>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<Extract<StorefrontRoute, { route: 'order' }>['params']>().toEqualTypeOf<
      { id: string } | { outTradeNo: string }
    >();
    expectTypeOf<'nowhere'>().not.toExtend<StorefrontRouteKey>();
  });
});

describe('order: by id or by outTradeNo, exactly one', () => {
  it.each([[{ id: '3001' }], [{ outTradeNo: 'P20260923120000123456' }]])('accepts %j', (params) => {
    expect(storefrontRoute.safeParse({ route: 'order', params }).success).toBe(true);
  });

  it.each([
    ['neither', {}],
    ['both', { id: '3001', outTradeNo: 'P20260923120000123456' }],
    ['a too-short outTradeNo', { outTradeNo: 'P1' }],
    ['an outTradeNo with a slash', { outTradeNo: 'P2026/0923' }],
  ])('refuses %s', (_label, params) => {
    expect(storefrontRoute.safeParse({ route: 'order', params }).success).toBe(false);
  });
});

describe('login.redirect is a JSON-encoded route, never a path', () => {
  const login = (redirect: string) => ({ route: 'login', params: { redirect } });

  it('accepts a route', () => {
    const redirect = JSON.stringify({ route: 'order', params: { id: '3001' } });
    expect(storefrontRoute.safeParse(login(redirect)).success).toBe(true);
    expect(storefrontRoute.safeParse({ route: 'login', params: {} }).success).toBe(true);
  });

  it.each([
    ['a mini-program path', '/pages/order/detail/index?id=3001'],
    ['a URL', 'https://evil.example/'],
    ['JSON that is not a route', JSON.stringify({ route: 'nowhere', params: {} })],
    ['a route with bad params', JSON.stringify({ route: 'product', params: {} })],
    ['a redirect back to login', JSON.stringify({ route: 'login', params: {} })],
  ])('refuses %s', (_label, redirect) => {
    expect(storefrontRoute.safeParse(login(redirect)).success).toBe(false);
  });
});

describe('toMiniPath', () => {
  it('writes the path with no leading slash, and no `?` without params', () => {
    expect(toMiniPath({ route: 'product', params: { id: '42' } })).toBe(
      'pages/product/index?id=42',
    );
    expect(toMiniPath({ route: 'messages', params: {} })).toBe('packages/account/messages/index');
    expect(toMiniPath({ route: 'orderList', params: {} })).toBe('packages/order/list/index');
  });

  it('orders params by name and leaves out absent optional ones', () => {
    expect(toMiniPath({ route: 'logistics', params: { shipmentId: '9', orderId: '3001' } })).toBe(
      'packages/order/logistics/index?orderId=3001&shipmentId=9',
    );
    expect(
      toMiniPath({ route: 'productList', params: { categoryId: '5', keyword: undefined } }),
    ).toBe('packages/goods/list/index?categoryId=5');
  });

  it('URI-encodes values', () => {
    expect(toMiniPath({ route: 'search', params: { keyword: '绿茶 & 红茶=好' } })).toBe(
      `packages/goods/search/index?keyword=${encodeURIComponent('绿茶 & 红茶=好')}`,
    );
    const redirect = JSON.stringify({ route: 'product', params: { id: '42' } });
    const path = toMiniPath({ route: 'login', params: { redirect } });
    expect(path).toBe(`pages/login/index?redirect=${encodeURIComponent(redirect)}`);
    expect(decodeURIComponent(path.split('redirect=')[1] ?? '')).toBe(redirect);
  });

  it('gives a tab page no query: its params travel through pendingTabParams', () => {
    expect(toMiniPath({ route: 'home', params: {} })).toBe('pages/index/index');
    expect(toMiniPath({ route: 'category', params: { categoryId: '7' } })).toBe(
      'pages/category/index',
    );
  });

  it('refuses a route that does not parse', () => {
    expect(() =>
      toMiniPath({ route: 'product', params: {} } as unknown as StorefrontRoute),
    ).toThrow();
    expect(() =>
      toMiniPath({ route: 'nowhere', params: {} } as unknown as StorefrontRoute),
    ).toThrow();
  });
});

describe('scene encoding (mini-program codes)', () => {
  const sample = (key: StorefrontRouteKey): StorefrontRoute =>
    (storefrontRoutes[key].params.safeParse({}).success
      ? { route: key, params: {} }
      : { route: key, params: { id: MAX_ID } }) as StorefrontRoute;

  it.each(miniCodeKeys)('%s round-trips, within 32 bytes and WeChat-safe', (key) => {
    const route = sample(key);
    const scene = encodeScene(route);
    expect(Buffer.byteLength(scene)).toBeLessThanOrEqual(SCENE_MAX_BYTES);
    expect(scene).toMatch(/^[0-9A-Za-z!#$&'()*+,/:;=?@\-._~]+$/);
    expect(decodeScene(key, scene)).toEqual(route.params);
    // options.scene arrives URI-encoded; both forms decode.
    expect(decodeScene(key, encodeURIComponent(scene))).toEqual(route.params);
  });

  it('writes `id=<id>` for an id, `_` for no params', () => {
    expect(encodeScene({ route: 'product', params: { id: '3001' } })).toBe('id=3001');
    expect(encodeScene({ route: 'home', params: {} })).toBe('_');
    expect(encodeScene({ route: 'couponCenter', params: {} })).toBe('_');
    expect(encodeScene({ route: 'product', params: { id: MAX_ID } })).toHaveLength(22);
  });

  it('types the decoded params by key', () => {
    const params = decodeScene('product', 'id=1');
    expectTypeOf(params).toEqualTypeOf<{ id: string }>();
  });

  it.each(storefrontRouteKeys.filter((key) => !storefrontRouteDef(key).miniCode))(
    'refuses %s, which has no mini-program code',
    (key) => {
      expect(() => encodeScene({ route: key, params: {} } as StorefrontRoute)).toThrow(
        /不能生成小程序码/,
      );
      expect(() => decodeScene(key, '_')).toThrow(/不能生成小程序码/);
    },
  );

  it('refuses an unknown key', () => {
    expect(() =>
      encodeScene({ route: 'nowhere', params: {} } as unknown as StorefrontRoute),
    ).toThrow(/未知的路由 key/);
    expect(() => decodeScene('nowhere' as StorefrontRouteKey, '_')).toThrow(/未知的路由 key/);
  });

  it('refuses invalid params on the way in', () => {
    expect(() => encodeScene({ route: 'product', params: { id: 'abc' } })).toThrow();
  });

  it('refuses a scene over 32 bytes', () => {
    // No id fits past 19 digits today, so the limit is checked with a longer one.
    const longId = '1'.repeat(30);
    expect(storefrontRoute.safeParse({ route: 'product', params: { id: longId } }).success).toBe(
      true,
    );
    expect(() => encodeScene({ route: 'product', params: { id: longId } })).toThrow(/32 字节/);
  });

  it.each([
    ['a missing id', 'product', '_'],
    ['an empty scene for an id key', 'product', ''],
    ['an id that is not a decimal string', 'product', 'id=abc'],
    ['a param the key does not take', 'product', 'id=1&r=2'],
    ['a repeated param', 'product', 'id=1&id=2'],
    ['a pair without `=`', 'product', 'id'],
    ['params for a key that takes none', 'home', 'id=1'],
  ])('refuses to decode %s', (_label, key, scene) => {
    expect(() => decodeScene(key as StorefrontRouteKey, scene)).toThrow();
  });
});
