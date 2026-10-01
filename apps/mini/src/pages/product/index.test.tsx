import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppConfigStore } from '@/app-config';
import { useCheckoutDraft } from '@/features/checkout/draft';
import { startSession, useSession } from '@/session/session';
import { appConfigFixture } from '@/test/app-config-fixture';
import { cardFixture, pageOf, productDetailFixture, reviewFixture } from '@/test/catalog-fixture';
import { holdRequests, serveApi, type FakeReply } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { routeQueryKey } from '@shop/api-client/react';
import { taroFake } from '@/test/taro-fake/taro';
import ProductPage from './index';

const empty = { items: [], total: 0, page: 1, pageSize: 100 };
const coupon = (templateId: string, scope: string, name: string) => ({
  templateId,
  name,
  discountAmount: '5.00',
  minSpend: '50.00',
  scope,
  validityMode: 'fixed_window',
  validFrom: '2026-09-01T00:00:00+08:00',
  validTo: '2026-12-31T23:59:59+08:00',
  validDays: null,
  claimTo: null,
  isUnlimitedSupply: true,
  remainingCount: null,
  perUserLimit: 1,
  claimedCount: null,
  canClaim: null,
});

type Routes = Record<string, (body: unknown) => FakeReply>;

function serve(overrides: Routes = {}) {
  return serveApi({
    'GET /api/v1/catalog/products/12': () => ({ body: productDetailFixture() }),
    'GET /api/v1/catalog/products/12/reviews': () => ({
      body: { items: [reviewFixture()], total: 2, page: 1, pageSize: 2 },
    }),
    'GET /api/v1/catalog/products': () => ({
      body: pageOf([cardFixture(), cardFixture({ id: '31', name: '温感按摩油' })]),
    }),
    'GET /api/v1/groupbuy/activities': () => ({
      body: {
        ...empty,
        items: [
          {
            activityId: '7',
            productId: '12',
            title: '两人拼',
            intro: null,
            imageUrl: null,
            price: '49.00',
            originalPrice: '59.00',
            seatsRequired: 2,
            stock: 10,
            sales: 0,
            startAt: '2026-09-01T00:00:00+08:00',
            endAt: '2026-12-01T00:00:00+08:00',
            formingGroups: 0,
            canBuy: true,
          },
        ],
        total: 1,
      },
    }),
    'GET /api/v1/presale/activities': () => ({ body: empty }),
    'GET /api/v1/coupons': () => ({
      body: {
        ...empty,
        items: [coupon('1', 'all_products', '全场满减券'), coupon('2', 'products', '指定商品券')],
        total: 2,
      },
    }),
    'POST /api/v1/visits': () => ({ status: 204, body: null }),
    'GET /api/v1/cart/count': () => ({
      body: { items: 2, quantity: 2, availableCount: 2, unavailableCount: 0 },
    }),
    ...overrides,
  });
}

async function signIn() {
  taroFake.storage.set('shop.session.token', 't1');
  await startSession();
}

describe('商品详情', () => {
  beforeEach(() => {
    taroFake.routerParams = { id: '12' };
    useSession.setState({ session: { status: 'idle' } });
    useAppConfigStore.setState({ config: appConfigFixture, source: 'network' });
    useCheckoutDraft.setState({ draft: null });
  });

  it('shows the product to a guest: price, reviews, description, services and recommendations', async () => {
    serve();
    await renderPage(<ProductPage />);

    expect(await screen.findByText('柔雾丝绒礼盒', { selector: '#product-name' })).toBeTruthy();
    // 为你推荐 may already be there too (asked for beside the product), with its own 已售.
    const summary = document.querySelector('.product__summary') as HTMLElement;
    expect(within(summary).getByText('已售 128')).toBeTruthy();
    expect(screen.getByText('评价 (2)')).toBeTruthy();
    expect(await screen.findByText('包装很严实，质感不错。')).toBeTruthy();
    expect(screen.getByText('礼盒图文详情')).toBeTruthy();
    expect(screen.getByText('隐私发货')).toBeTruthy();
    expect(await screen.findByText('温感按摩油')).toBeTruthy();
    // The product itself is not recommended to itself.
    expect(
      within(document.getElementById('product-recommended') as HTMLElement).queryByText(
        '柔雾丝绒礼盒',
      ),
    ).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: /好评率 100%/ }));
    expect(taroFake.calls).toContainEqual({
      api: 'navigateTo',
      args: { url: '/packages/goods/reviews/index?productId=12' },
    });
  });

  it('asks for this product’s activities and coupons, and shows them', async () => {
    const seen = serve();
    await renderPage(<ProductPage />);

    fireEvent.click(await screen.findByRole('link', { name: '拼团 ¥49.00，2 人团' }));
    expect(taroFake.calls).toContainEqual({
      api: 'navigateTo',
      args: { url: '/packages/promo/groupbuy-detail/index?id=7' },
    });
    for (const key of ['GET /api/v1/groupbuy/activities', 'GET /api/v1/presale/activities']) {
      expect(seen.find((r) => r.key === key)?.query).toEqual({ productId: '12', pageSize: '1' });
    }

    // The server narrows the coupons to those the product counts towards (COUPON-009).
    fireEvent.click(await screen.findByRole('link', { name: '领取优惠券' }));
    expect(screen.getByText('全场满减券')).toBeTruthy();
    expect(screen.getByText('指定商品券')).toBeTruthy();
    expect(seen.find((r) => r.key === 'GET /api/v1/coupons')?.query).toMatchObject({
      productId: '12',
    });
  });

  it('asks for the activities, coupons, reviews and recommendations while the product is on its way', async () => {
    const seen = serve();
    const held = holdRequests('/api/v1/catalog/products/12');
    // The app's 30 s staleTime: what the prefetch brought is not asked for again on mount.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 30_000 } },
    });
    await renderPage(<ProductPage />, client);

    const secondary = [
      'GET /api/v1/groupbuy/activities',
      'GET /api/v1/presale/activities',
      'GET /api/v1/coupons',
      'GET /api/v1/catalog/products/12/reviews',
      'GET /api/v1/catalog/products',
    ];
    await waitFor(() => expect(seen.map((r) => r.key)).toEqual(expect.arrayContaining(secondary)));
    expect(screen.getByText('', { selector: '#product-loading' })).toBeTruthy();

    held.release();
    expect(await screen.findByRole('link', { name: '拼团 ¥49.00，2 人团' })).toBeTruthy();
    expect(await screen.findByText('包装很严实，质感不错。')).toBeTruthy();
    expect(await screen.findByText('温感按摩油')).toBeTruthy();
    expect(screen.getByRole('link', { name: '领取优惠券' })).toBeTruthy();
    // Each asked for once: the sections read what the prefetch brought.
    for (const key of secondary) expect(seen.filter((r) => r.key === key)).toHaveLength(1);
  });

  it('keeps the page up when the secondary reads fail', async () => {
    const down = () => ({ status: 500, body: { code: 'INTERNAL', message: '服务器开小差了' } });
    serve({
      'GET /api/v1/groupbuy/activities': down,
      'GET /api/v1/presale/activities': down,
      'GET /api/v1/coupons': down,
      'GET /api/v1/catalog/products/12/reviews': down,
      'GET /api/v1/catalog/products': down,
    });
    await renderPage(<ProductPage />);

    expect(await screen.findByText('柔雾丝绒礼盒', { selector: '#product-name' })).toBeTruthy();
    expect(screen.getByText('评价 (2)')).toBeTruthy();
    expect(screen.getByRole('button', { name: '立即购买' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /拼团/ })).toBeNull();
    expect(screen.queryByRole('link', { name: '领取优惠券' })).toBeNull();
    expect(document.getElementById('product-recommended')).toBeNull();
  });

  it('shows no group-buy bar for an activity the shopper cannot buy', async () => {
    serve({
      'GET /api/v1/groupbuy/activities': () => ({
        body: {
          ...empty,
          items: [
            {
              activityId: '7',
              productId: '12',
              title: '两人拼',
              intro: null,
              imageUrl: null,
              price: '49.00',
              originalPrice: '59.00',
              seatsRequired: 2,
              stock: 0,
              sales: 10,
              startAt: '2026-09-01T00:00:00+08:00',
              endAt: '2026-12-01T00:00:00+08:00',
              formingGroups: 0,
              canBuy: false,
            },
          ],
          total: 1,
        },
      }),
    });
    await renderPage(<ProductPage />);
    await screen.findByText('柔雾丝绒礼盒', { selector: '#product-name' });
    await screen.findByRole('link', { name: '领取优惠券' });
    expect(screen.queryByRole('link', { name: /拼团/ })).toBeNull();
  });

  it('SYS-015 — hides 评价, 为你推荐 and 服务 when the shop switched them off', async () => {
    useAppConfigStore.setState({
      config: {
        ...appConfigFixture,
        display: {
          ...appConfigFixture.display,
          productReviews: false,
          productRecommendations: false,
          productServiceTags: false,
        },
      },
    });
    const seen = serve();
    await renderPage(<ProductPage />);
    await screen.findByText('柔雾丝绒礼盒', { selector: '#product-name' });
    await screen.findByRole('link', { name: '领取优惠券' });

    expect(screen.queryByText('评价 (2)')).toBeNull();
    expect(screen.queryByText('隐私发货')).toBeNull();
    expect(document.getElementById('product-recommended')).toBeNull();
    expect(seen.some((r) => r.key === 'GET /api/v1/catalog/products/12/reviews')).toBe(false);
    expect(seen.some((r) => r.key === 'GET /api/v1/catalog/products')).toBe(false);
    // The rest of the page stays.
    expect(screen.getByText('礼盒图文详情')).toBeTruthy();
  });

  it('asks a guest to log in at 加入购物车, coming back to the product', async () => {
    taroFake.loginCode = 'code-1';
    serve({
      'POST /api/v1/auth/sessions/wechat-mini': () => ({
        status: 201,
        body: {
          status: 'phone-required',
          session: null,
          registered: false,
          bindToken: 'bind-1',
          bindTokenExpiresInSec: 600,
        },
      }),
    });
    await renderPage(<ProductPage />);

    fireEvent.click(await screen.findByRole('button', { name: '加入购物车' }));

    const redirect = JSON.stringify({ route: 'product', params: { id: '12' } });
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: `/pages/login/index?redirect=${encodeURIComponent(redirect)}` },
      }),
    );
    expect(document.getElementById('sku-sheet')).toBeNull();
  });

  it('adds the chosen SKU to the cart', async () => {
    const seen = serve({
      'POST /api/v1/cart/items': () => ({
        status: 201,
        body: {
          item: null,
          cart: { items: 1, quantity: 1, availableCount: 1, unavailableCount: 0 },
        },
      }),
    });
    await signIn();
    await renderPage(<ProductPage />);

    fireEvent.click(await screen.findByRole('button', { name: '加入购物车' }));
    const sheet = await waitFor(() => {
      const found = document.getElementById('sku-sheet');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(sheet).getByRole('radio', { name: 'L' })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('radio', { name: '黑' }));
    fireEvent.click(within(sheet).getByRole('radio', { name: 'M' }));
    fireEvent.click(screen.getAllByRole('button', { name: '加入购物车' }).at(-1) as HTMLElement);

    await waitFor(() =>
      expect(seen.filter((r) => r.key === 'POST /api/v1/cart/items').map((r) => r.body)).toEqual([
        { skuId: '103', quantity: 1 },
      ]),
    );
  });

  it('AGENTS 17 — a double tap on the sheet’s 加入购物车 adds once', async () => {
    const seen = serve({
      'POST /api/v1/cart/items': () => ({
        status: 201,
        body: {
          item: null,
          cart: { items: 1, quantity: 1, availableCount: 1, unavailableCount: 0 },
        },
      }),
    });
    await signIn();
    await renderPage(<ProductPage />);

    fireEvent.click(await screen.findByRole('button', { name: '加入购物车' }));
    const sheet = await waitFor(() => {
      const found = document.getElementById('sku-sheet');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    fireEvent.click(within(sheet).getByRole('radio', { name: '黑' }));
    fireEvent.click(within(sheet).getByRole('radio', { name: 'M' }));
    const held = holdRequests('/api/v1/cart/items');
    const add = screen.getAllByRole('button', { name: '加入购物车' }).at(-1) as HTMLElement;
    // Both taps before React re-renders, as on a phone: only the button's own lock stops the second.
    act(() => {
      add.click();
      add.click();
    });

    await waitFor(() => {
      held.release();
      expect(taroFake.calls).toContainEqual({
        api: 'showToast',
        args: expect.objectContaining({ title: '已加入购物车' }),
      });
    });
    expect(seen.filter((r) => r.key === 'POST /api/v1/cart/items')).toHaveLength(1);
  });

  it('buys now: the draft carries the SKU and quantity, then checkout opens', async () => {
    serve();
    await signIn();
    await renderPage(<ProductPage />);

    fireEvent.click(await screen.findByRole('button', { name: '立即购买' }));
    const sheet = await waitFor(() => {
      const found = document.getElementById('sku-sheet');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    fireEvent.click(within(sheet).getByRole('radio', { name: '白' }));
    fireEvent.click(within(sheet).getByRole('radio', { name: 'M' }));
    fireEvent.click(screen.getAllByRole('button', { name: '立即购买' }).at(-1) as HTMLElement);

    expect(useCheckoutDraft.getState().draft).toMatchObject({
      source: 'buy-now',
      item: { skuId: '101', quantity: 1 },
      kind: 'normal',
      names: { '101': expect.any(String) },
    });
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: '/packages/order/checkout/index' },
      }),
    );
  });

  it('favourites and un-favourites', async () => {
    const seen = serve({
      'POST /api/v1/me/favorites': () => ({ status: 201, body: { favorited: true } }),
      'DELETE /api/v1/me/favorites/12': () => ({ status: 204, body: null }),
    });
    await signIn();
    const { client } = await renderPage(<ProductPage />);
    // 我的收藏, under this page when the product was opened from it.
    const favorites = routeQueryKey('catalog.favoriteList', { query: { pageSize: 20 } });
    client.setQueryData(favorites, { items: [], page: 1, pageSize: 20, total: 0 });
    // Another 商品详情 under this one, which says 收藏 or 已收藏 too.
    const other = routeQueryKey('catalog.productDetail', { params: { id: '99' } });
    client.setQueryData(other, productDetailFixture({ id: '99' }));

    const heart = await screen.findByRole('button', { name: '收藏' });
    fireEvent.click(heart);
    // A second tap while the first is on its way is not a remove racing the add.
    fireEvent.click(heart);
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'showToast',
        args: expect.objectContaining({ title: '已收藏' }),
      }),
    );
    const favoriteCalls = () =>
      seen.map((r) => r.key).filter((key) => key.includes('/me/favorites'));
    expect(favoriteCalls()).toEqual(['POST /api/v1/me/favorites']);
    expect(client.getQueryState(other)?.isInvalidated).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '已收藏' }));
    await waitFor(() =>
      expect(favoriteCalls()).toEqual([
        'POST /api/v1/me/favorites',
        'DELETE /api/v1/me/favorites/12',
      ]),
    );
    await waitFor(() => expect(client.getQueryState(favorites)?.isInvalidated).toBe(true));
    expect(await screen.findByRole('button', { name: '收藏' })).toBeTruthy();
  });

  it('AGENTS 16 — says 已收藏 once signed in, for a product read before the session', async () => {
    // The server knows whether it is kept only for a signed-in shopper.
    serve({
      'GET /api/v1/catalog/products/12': () => ({
        body: productDetailFixture({
          favorited: useSession.getState().session.status === 'signed-in' ? true : null,
        }),
      }),
    });
    await renderPage(<ProductPage />);
    expect(await screen.findByRole('button', { name: '收藏' })).toBeTruthy();

    // The silent login lands while the shared product is open.
    await act(() => signIn());
    expect(await screen.findByRole('button', { name: '已收藏' })).toBeTruthy();
  });

  it('shows a sold-out product with one disabled button', async () => {
    serve({
      'GET /api/v1/catalog/products/12': () => ({
        body: productDetailFixture({
          stock: 0,
          skus: productDetailFixture().skus.map((sku) => ({ ...sku, stock: 0 })),
        }),
      }),
    });
    await renderPage(<ProductPage />);

    const button = await screen.findByRole('button', { name: '已售罄' });
    expect(
      (button as HTMLButtonElement).disabled || button.getAttribute('aria-disabled'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: '加入购物车' })).toBeNull();
  });

  it('says an off-shelf product is gone', async () => {
    serve({
      'GET /api/v1/catalog/products/12': () => ({
        status: 404,
        body: { code: 'CATALOG_PRODUCT_NOT_FOUND', message: '商品不存在' },
      }),
    });
    await renderPage(<ProductPage />);
    expect(await screen.findByText('商品已下架')).toBeTruthy();
  });

  it('says a product is gone even though its secondary reads went out first', async () => {
    const seen = serve({
      'GET /api/v1/catalog/products/12': () => ({
        status: 404,
        body: { code: 'CATALOG_PRODUCT_NOT_FOUND', message: '商品不存在' },
      }),
      'GET /api/v1/catalog/products/12/reviews': () => ({
        status: 404,
        body: { code: 'CATALOG_PRODUCT_NOT_FOUND', message: '商品不存在' },
      }),
    });
    const held = holdRequests('/api/v1/catalog/products/12');
    await renderPage(<ProductPage />);
    await waitFor(() =>
      expect(seen.some((r) => r.key === 'GET /api/v1/groupbuy/activities')).toBe(true),
    );

    held.release();
    expect(await screen.findByText('商品已下架')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /拼团/ })).toBeNull();
  });

  it('records the visit and shares the product', async () => {
    const seen = serve();
    await renderPage(<ProductPage />);
    await screen.findByText('柔雾丝绒礼盒', { selector: '#product-name' });
    taroFake.showPage();

    await waitFor(() =>
      expect(seen.find((r) => r.key === 'POST /api/v1/visits')?.body).toEqual({
        path: '/pages/product/index',
      }),
    );
    const share = taroFake.shareHandlers.message?.();
    expect(share).toMatchObject({ title: '柔雾丝绒礼盒', path: '/pages/product/index?id=12' });
  });

  it('draws the product poster from 分享 → 生成海报', async () => {
    const seen = serve({
      'GET /api/v1/share/mini-codes': () => ({ body: { url: '/uploads/wechat-mini-code/a.png' } }),
    });
    await signIn();
    await renderPage(<ProductPage />);
    await screen.findByText('柔雾丝绒礼盒', { selector: '#product-name' });
    fireEvent.click(screen.getByRole('button', { name: '分享' }));
    fireEvent.click(await screen.findByRole('button', { name: '生成分享海报' }));
    expect((await screen.findByAltText('分享海报')).getAttribute('src')).toBe(
      'wxfile://tmp/poster.jpg',
    );
    expect(seen.find((r) => r.key === 'GET /api/v1/share/mini-codes')?.query).toEqual({
      route: 'product',
      id: '12',
    });
  });

  it('SYS-015 — offers no poster when the shop switched product posters off, still shares to a friend', async () => {
    useAppConfigStore.setState({
      config: {
        ...appConfigFixture,
        display: { ...appConfigFixture.display, productPoster: false },
      },
    });
    const seen = serve();
    await signIn();
    await renderPage(<ProductPage />);
    await screen.findByText('柔雾丝绒礼盒', { selector: '#product-name' });
    fireEvent.click(screen.getByRole('button', { name: '分享' }));

    expect(await screen.findByRole('button', { name: '发送给微信好友' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '生成分享海报' })).toBeNull();
    expect(screen.queryByText('生成海报')).toBeNull();
    expect(seen.some((r) => r.key === 'GET /api/v1/share/mini-codes')).toBe(false);
  });

  it('asks a guest to log in before drawing a poster', async () => {
    useSession.setState({ session: { status: 'phone-required', bindToken: 'b' } });
    const seen = serve();
    await renderPage(<ProductPage />);
    await screen.findByText('柔雾丝绒礼盒', { selector: '#product-name' });
    fireEvent.click(screen.getByRole('button', { name: '分享' }));
    fireEvent.click(await screen.findByRole('button', { name: '生成分享海报' }));
    await waitFor(() =>
      expect(
        taroFake.calls.some(
          (call) =>
            call.api === 'navigateTo' &&
            (call.args as { url: string }).url.startsWith('/pages/login/index?redirect='),
        ),
      ).toBe(true),
    );
    expect(seen.some((r) => r.key === 'GET /api/v1/share/mini-codes')).toBe(false);
  });
});
