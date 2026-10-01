import { afterEach, describe, expect, it, vi } from 'vitest';
import Taro from '@tarojs/taro';
import { taroFake } from '@/test/taro-fake/taro';
import {
  goBack,
  leaveFor,
  loginReturn,
  navigate,
  parseLoginRedirect,
  readRouteParams,
  returnFromLogin,
  routeKeyOfPath,
  takeTabParams,
  toPath,
} from './nav';

const lastCall = () => taroFake.calls.at(-1);

describe('toPath', () => {
  it('builds the page path with the known params, sorted and encoded', () => {
    expect(toPath({ route: 'payResult', params: { outTradeNo: 'P9', orderId: '9' } })).toBe(
      '/packages/order/pay-result/index?orderId=9&outTradeNo=P9',
    );
    expect(toPath({ route: 'search', params: { keyword: '坚果 礼盒' } })).toBe(
      '/packages/goods/search/index?keyword=%E5%9D%9A%E6%9E%9C%20%E7%A4%BC%E7%9B%92',
    );
    expect(toPath({ route: 'product', params: { id: '1', stray: 'x' } as never })).toBe(
      '/pages/product/index?id=1',
    );
  });

  it('opens home for a key it does not know', () => {
    expect(toPath({ route: 'no-such-page' })).toBe('/pages/index/index');
  });
});

describe('navigate', () => {
  it('pushes a page, or replaces it on request and when the stack is full', async () => {
    await navigate({ route: 'product', params: { id: '1' } });
    expect(lastCall()).toEqual({ api: 'navigateTo', args: { url: '/pages/product/index?id=1' } });
    await navigate({ route: 'product', params: { id: '2' } }, { replace: true });
    expect(lastCall()?.api).toBe('redirectTo');
    taroFake.pageStackDepth = 10;
    await navigate({ route: 'product', params: { id: '3' } });
    expect(lastCall()?.api).toBe('redirectTo');
  });

  it('switches to a tab and hands it the params once', async () => {
    await navigate({ route: 'category', params: { categoryId: '7' } });
    expect(lastCall()).toEqual({ api: 'switchTab', args: { url: '/pages/category/index' } });
    expect(readRouteParams('category', {})).toEqual({ categoryId: '7' });
    expect(takeTabParams('category')).toEqual({});
  });

  it('sends an unknown key home', async () => {
    await navigate({ route: 'staff-orders' });
    expect(lastCall()).toEqual({ api: 'switchTab', args: { url: '/pages/index/index' } });
  });

  describe('a double tap opens the page once (K3)', () => {
    const product = { route: 'product', params: { id: '1' } } as const;
    const opens = () => taroFake.calls.filter((call) => call.api === 'navigateTo').length;

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('shares the open under way with a second call for the same page', async () => {
      let land = () => undefined as void;
      vi.spyOn(Taro, 'navigateTo').mockImplementation((args) => {
        taroFake.calls.push({ api: 'navigateTo', args });
        return new Promise((resolve) => {
          land = () => resolve({ errMsg: 'navigateTo:ok' } as never);
        });
      });
      const first = navigate(product);
      const second = navigate(product);
      land();
      await Promise.all([first, second]);
      expect(opens()).toBe(1);
    });

    it('drops the same page just landed while the shopper is still on it, not after going back or later', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      await navigate(product);
      await navigate(product);
      expect(opens()).toBe(1);

      // Went back (the stack changed): the tap is a new one.
      taroFake.pageStackDepth = 2;
      await navigate(product);
      expect(opens()).toBe(2);

      vi.advanceTimersByTime(500);
      await navigate(product);
      expect(opens()).toBe(3);
    });

    it('lets another page, a replace of the same page, and a tab through', async () => {
      await navigate(product);
      await navigate({ route: 'product', params: { id: '2' } });
      await navigate(product, { replace: true });
      await navigate({ route: 'cart', params: {} });
      await navigate({ route: 'cart', params: {} });
      expect(taroFake.calls.map((call) => call.api)).toEqual([
        'navigateTo',
        'navigateTo',
        'redirectTo',
        'switchTab',
        'switchTab',
      ]);
    });

    it('forgets a failed open, so trying again opens the page', async () => {
      const spy = vi.spyOn(Taro, 'navigateTo').mockRejectedValueOnce(new Error('navigateTo:fail'));
      await expect(navigate(product)).rejects.toThrow('navigateTo:fail');
      spy.mockRestore();
      await navigate(product);
      expect(opens()).toBe(1);
    });
  });

  it('goes back, or home when there is nothing behind', async () => {
    taroFake.pageStackDepth = 2;
    await goBack();
    expect(lastCall()?.api).toBe('navigateBack');
    taroFake.pageStackDepth = 1;
    await goBack();
    expect(lastCall()?.api).toBe('switchTab');
  });
});

describe('readRouteParams', () => {
  it('keeps only the declared params and decodes them', () => {
    expect(readRouteParams('search', { keyword: '%E5%9D%9A%E6%9E%9C', other: 'x' })).toEqual({
      keyword: '坚果',
    });
  });

  it('reads a mini-program code scene', () => {
    expect(readRouteParams('product', { scene: encodeURIComponent('id=11&x=1') })).toEqual({
      id: '11',
    });
    expect(readRouteParams('product', { scene: '_' })).toEqual({});
  });
});

describe('parseLoginRedirect', () => {
  it('accepts a known route and drops unknown params', () => {
    expect(
      parseLoginRedirect(JSON.stringify({ route: 'product', params: { id: '1', evil: 'x' } })),
    ).toEqual({
      route: 'product',
      params: { id: '1' },
    });
  });

  it('refuses garbage, unknown routes and the login page itself', () => {
    expect(parseLoginRedirect('not json')).toBeNull();
    expect(parseLoginRedirect(JSON.stringify({ route: 'nope' }))).toBeNull();
    expect(parseLoginRedirect(JSON.stringify({ route: 'login' }))).toBeNull();
    expect(parseLoginRedirect(undefined)).toBeNull();
  });

  it('maps a page path back to its key', () => {
    expect(routeKeyOfPath('/packages/order/cashier/index?orderId=1')).toBe('cashier');
    expect(routeKeyOfPath('pages/nowhere')).toBeNull();
  });
});

describe('loginReturn', () => {
  const product = { route: 'product', params: { id: '7' } } as const;
  const login = { route: 'packages/account/login/index' };

  it('goes back to the page under login when it is the target (WeChat: route + options)', () => {
    const stack = [{ route: 'pages/product/index', options: { id: '7' } }, login];
    expect(loginReturn(product, stack)).toBe('back');
  });

  it('goes back on H5, where the params are only in the path', () => {
    const stack = [
      { route: '/pages/product/index', path: '/pages/product/index?id=7&stamp=3' },
      { route: '/pages/login/index', path: '/pages/login/index?redirect=x&stamp=4' },
    ];
    expect(loginReturn(product, stack)).toBe('back');
  });

  it('goes back to a product opened from a mini-program code (scene)', () => {
    const stack = [{ route: 'pages/product/index', options: { scene: 'id%3D7' } }, login];
    expect(loginReturn(product, stack)).toBe('back');
  });

  it('replaces login when the page under it is another page, or another product', () => {
    expect(loginReturn(product, [{ route: 'pages/category/index', options: {} }, login])).toBe(
      'replace',
    );
    expect(
      loginReturn(product, [{ route: 'pages/product/index', options: { id: '8' } }, login]),
    ).toBe('replace');
  });

  it('replaces login when it is the first page (opened from a share)', () => {
    expect(loginReturn(product, [login])).toBe('replace');
    expect(loginReturn(product, [])).toBe('replace');
  });

  it('goes back to a tab under it, unless the tab is sent params', () => {
    const stack = [{ route: 'pages/cart/index', options: {} }, login];
    expect(loginReturn({ route: 'cart', params: {} }, stack)).toBe('back');
    const category = [{ route: 'pages/category/index', options: {} }, login];
    expect(loginReturn({ route: 'category', params: { categoryId: '3' } }, category)).toBe(
      'replace',
    );
  });

  it('navigates back, or replaces login with the target', async () => {
    taroFake.pageStack = [{ route: 'pages/product/index', options: { id: '7' } }, login];
    await returnFromLogin(product);
    expect(lastCall()).toEqual({ api: 'navigateBack', args: { delta: 1 } });
    taroFake.pageStack = [{ route: 'pages/index/index', options: {} }, login];
    await returnFromLogin(product);
    expect(lastCall()).toEqual({ api: 'redirectTo', args: { url: '/pages/product/index?id=7' } });
  });
});

describe('leaveFor', () => {
  const order = { route: 'order', params: { id: '9' } } as const;
  const orderPage = { route: 'packages/order/detail/index', options: { id: '9' } };
  const team = { route: 'packages/promo/groupbuy-team/index', options: { id: '5' } };
  const payResult = { route: 'packages/order/pay-result/index', options: { orderId: '9' } };

  it('goes back to the order however deep it is, not to a second copy of it', async () => {
    // 订单详情 → 拼团进度 → 收银台 → 支付结果 (in place of 收银台) → 查看订单.
    taroFake.pageStack = [{ route: 'pages/index/index', options: {} }, orderPage, team, payResult];
    await leaveFor(order);
    expect(lastCall()).toEqual({ api: 'navigateBack', args: { delta: 2 } });
  });

  it('takes the place of this page when the order is not on the stack', async () => {
    taroFake.pageStack = [{ route: 'pages/index/index', options: {} }, team, payResult];
    await leaveFor(order);
    expect(lastCall()).toEqual({
      api: 'redirectTo',
      args: { url: '/packages/order/detail/index?id=9' },
    });
    // Another order on the stack is not this one.
    taroFake.pageStack = [{ ...orderPage, options: { id: '8' } }, team, payResult];
    await leaveFor(order);
    expect(lastCall()).toEqual({
      api: 'redirectTo',
      args: { url: '/packages/order/detail/index?id=9' },
    });
  });
});
