import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppConfigStore } from '@/app-config';
import { navigate } from '@/platform';
import { startSession, useSession } from '@/session/session';
import { appConfigFixture } from '@/test/app-config-fixture';
import { cartItemFixture } from '@/test/cart-fixture';
import {
  cardFixture,
  categoryTreeFixture,
  pageOf,
  singleSkuMatrix,
  skuMatrixFixture,
} from '@/test/catalog-fixture';
import { FIRST_CATEGORY_KEY } from '@/features/catalog/first-category';
import { holdRequests, serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import Category from './index';

const tree = { 'GET /api/v1/catalog/categories': () => ({ body: categoryTreeFixture }) };
const products = {
  'GET /api/v1/catalog/products': () => ({
    body: pageOf([cardFixture(), cardFixture({ id: '31', name: '温感按摩油', price: '39.00' })]),
  }),
};

const listRequests = (seen: ReturnType<typeof serveApi>) =>
  seen.filter((r) => r.key === 'GET /api/v1/catalog/products').map((r) => r.query.categoryIds);

describe('分类', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'idle' } });
    useAppConfigStore.setState({ config: appConfigFixture, source: 'network' });
  });

  it('lists level-1 categories and shows the first one’s banner, subcategories and products', async () => {
    const seen = serveApi({ ...tree, ...products });

    await renderPage(<Category />);

    const tab = await screen.findByRole('tab', { name: '精选好物' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('柔雾丝绒礼盒')).toBeTruthy();
    expect(screen.getByRole('link', { name: '礼盒' })).toBeTruthy();
    const list = seen.find((request) => request.key === 'GET /api/v1/catalog/products');
    expect(list?.query.categoryIds).toBe('1,11,12,121');

    fireEvent.click(screen.getByRole('link', { name: '护理' }));
    expect(taroFake.calls).toContainEqual({
      api: 'navigateTo',
      args: { url: '/packages/goods/list/index?categoryId=12' },
    });
  });

  it('hides the subcategories when the shop switched 显示二级类目 off', async () => {
    useAppConfigStore.setState({
      config: {
        ...appConfigFixture,
        display: { ...appConfigFixture.display, categorySubcategories: false },
      },
    });
    const seen = serveApi({ ...tree, ...products });
    await renderPage(<Category />);

    expect(await screen.findByText('柔雾丝绒礼盒')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '礼盒' })).toBeNull();
    // The products still cover the whole subtree.
    const list = seen.find((request) => request.key === 'GET /api/v1/catalog/products');
    expect(list?.query.categoryIds).toBe('1,11,12,121');
  });

  it('switches level-1 category from the rail', async () => {
    const seen = serveApi({ ...tree, ...products });
    await renderPage(<Category />);

    fireEvent.click(await screen.findByRole('tab', { name: '新品' }));

    await waitFor(() =>
      expect(seen.filter((r) => r.key === 'GET /api/v1/catalog/products').at(-1)?.query).toEqual(
        expect.objectContaining({ categoryIds: '2' }),
      ),
    );
    expect(screen.queryByRole('link', { name: '礼盒' })).toBeNull();
  });

  it('opens on the level-1 category holding a linked level-3 category', async () => {
    serveApi({ ...tree, ...products });
    await navigate({ route: 'category', params: { categoryId: '121' } });

    await renderPage(<Category />);

    const tab = await screen.findByRole('tab', { name: '精选好物' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
  });

  it('remembers the first category’s subtree for the next cold open', async () => {
    serveApi({ ...tree, ...products });
    await renderPage(<Category />);
    expect(await screen.findByText('柔雾丝绒礼盒')).toBeTruthy();
    expect(taroFake.storage.get(FIRST_CATEGORY_KEY)).toBe('["1","11","12","121"]');
  });

  it('on a cold open, asks for the first category’s products while the tree is on its way', async () => {
    taroFake.storage.set(FIRST_CATEGORY_KEY, '["1","11","12","121"]');
    const seen = serveApi({ ...tree, ...products });
    const held = holdRequests('/api/v1/catalog/categories');
    // The app's 30 s staleTime: a list just fetched is not asked for again on mount.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 30_000 } },
    });
    await renderPage(<Category />, client);

    // The list went out before the tree answered.
    await waitFor(() => expect(listRequests(seen)).toEqual(['1,11,12,121']));
    expect(screen.queryByRole('tab')).toBeNull();

    held.release();
    expect(await screen.findByText('柔雾丝绒礼盒')).toBeTruthy();
    // The page's list is the one already asked for: no second request.
    expect(listRequests(seen)).toEqual(['1,11,12,121']);
  });

  it('shows the fresh tree’s first category when the remembered one has changed', async () => {
    taroFake.storage.set(FIRST_CATEGORY_KEY, '["1","11"]');
    const seen = serveApi({ ...tree, ...products });
    await renderPage(<Category />);

    expect(await screen.findByText('柔雾丝绒礼盒')).toBeTruthy();
    // One unused guess, then the list the tree calls for.
    await waitFor(() => expect(listRequests(seen)).toEqual(['1,11', '1,11,12,121']));
    expect(taroFake.storage.get(FIRST_CATEGORY_KEY)).toBe('["1","11","12","121"]');
  });

  it('guesses nothing when opened on a category outside the remembered one', async () => {
    taroFake.storage.set(FIRST_CATEGORY_KEY, '["1","11","12","121"]');
    const seen = serveApi({ ...tree, ...products });
    await navigate({ route: 'category', params: { categoryId: '2' } });
    const held = holdRequests('/api/v1/catalog/categories');
    await renderPage(<Category />);
    await Promise.resolve();
    expect(listRequests(seen)).toEqual([]);

    held.release();
    const tab = await screen.findByRole('tab', { name: '新品' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(listRequests(seen)).toEqual(['2']));
  });

  it('asks for the tree again when the shopper comes back, so the admin’s changes show', async () => {
    let name = '精选好物';
    const seen = serveApi({
      'GET /api/v1/catalog/categories': () => ({
        body: {
          ...categoryTreeFixture,
          items: categoryTreeFixture.items.map((top, index) =>
            index === 0 ? { ...top, name } : top,
          ),
        },
      }),
      ...products,
    });
    await renderPage(<Category />);
    expect(await screen.findByRole('tab', { name: '精选好物' })).toBeTruthy();

    // Renamed in the admin while the shopper was on another tab; the tree is still fresh.
    name = '当季精选';
    act(() => taroFake.showPage());

    expect(await screen.findByRole('tab', { name: '当季精选' })).toBeTruthy();
    expect(seen.filter((r) => r.key === 'GET /api/v1/catalog/categories')).toHaveLength(2);
  });

  it('says so when the shop has no categories', async () => {
    serveApi({ 'GET /api/v1/catalog/categories': () => ({ body: { items: [], version: '0-0' } }) });
    await renderPage(<Category />);
    expect(await screen.findByText('暂无分类')).toBeTruthy();
  });

  it('adds a one-SKU product at once and opens the SkuSheet for one with specs', async () => {
    taroFake.storage.set('shop.session.token', 't1');
    const seen = serveApi({
      ...tree,
      ...products,
      'GET /api/v1/cart/count': () => ({
        body: { items: 0, quantity: 0, availableCount: 0, unavailableCount: 0 },
      }),
      'GET /api/v1/catalog/products/31/skus': () => ({ body: singleSkuMatrix('31') }),
      'GET /api/v1/catalog/products/12/skus': () => ({ body: skuMatrixFixture }),
      'POST /api/v1/cart/items': () => ({
        status: 201,
        body: {
          item: cartItemFixture({
            id: '9',
            productId: '31',
            skuId: '301',
            quantity: 1,
            productName: '温感按摩油',
            specText: '',
            unitPrice: '39.00',
            subtotal: '39.00',
          }),
          cart: { items: 1, quantity: 1, availableCount: 1, unavailableCount: 0 },
        },
      }),
    });
    await startSession();
    await renderPage(<Category />);

    const oil = (await screen.findByText('温感按摩油')).closest('[role="link"]') as HTMLElement;
    fireEvent.click(within(oil).getByRole('button', { name: /加入购物车/ }));
    await waitFor(() =>
      expect(seen.filter((r) => r.key === 'POST /api/v1/cart/items').map((r) => r.body)).toEqual([
        { skuId: '301', quantity: 1 },
      ]),
    );

    const box = screen.getByText('柔雾丝绒礼盒').closest('[role="link"]') as HTMLElement;
    fireEvent.click(within(box).getByRole('button', { name: /加入购物车/ }));
    expect(await screen.findByText('请选择 颜色 尺码')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /黑/ })).toBeTruthy();
  });

  it('AGENTS 17 — a double tap on a one-SKU card’s 加购 adds once', async () => {
    taroFake.storage.set('shop.session.token', 't1');
    const seen = serveApi({
      ...tree,
      ...products,
      'GET /api/v1/cart/count': () => ({
        body: { items: 0, quantity: 0, availableCount: 0, unavailableCount: 0 },
      }),
      'GET /api/v1/catalog/products/31/skus': () => ({ body: singleSkuMatrix('31') }),
      'POST /api/v1/cart/items': () => ({
        status: 201,
        body: {
          item: null,
          cart: { items: 1, quantity: 1, availableCount: 1, unavailableCount: 0 },
        },
      }),
    });
    await startSession();
    await renderPage(<Category />);

    const oil = (await screen.findByText('温感按摩油')).closest('[role="link"]') as HTMLElement;
    const add = within(oil).getByRole('button', { name: /加入购物车/ });
    const held = holdRequests('/api/v1/cart/items');
    // Both taps before React re-renders, as on a phone: only the card's own lock stops the second.
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

  it('sends a signed-out shopper to login from 加购, coming back to this category', async () => {
    taroFake.loginCode = 'code-1';
    serveApi({
      ...tree,
      ...products,
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
    await renderPage(<Category />);

    const box = (await screen.findByText('柔雾丝绒礼盒')).closest('[role="link"]') as HTMLElement;
    fireEvent.click(within(box).getByRole('button', { name: /加入购物车/ }));

    const redirect = JSON.stringify({ route: 'category', params: { categoryId: '1' } });
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: `/pages/login/index?redirect=${encodeURIComponent(redirect)}` },
      }),
    );
  });
});
