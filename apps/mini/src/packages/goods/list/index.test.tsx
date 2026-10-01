import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppConfigStore } from '@/app-config';
import { useSession } from '@/session/session';
import { appConfigFixture } from '@/test/app-config-fixture';
import { cardFixture, categoryTreeFixture, pageOf } from '@/test/catalog-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import ProductList from './index';

const lists = (seen: { key: string; query: Record<string, string> }[]) =>
  seen.filter((request) => request.key === 'GET /api/v1/catalog/products').map((r) => r.query);

const routes = {
  'GET /api/v1/catalog/categories': () => ({ body: categoryTreeFixture }),
  'GET /api/v1/catalog/products': () => ({
    body: pageOf([cardFixture(), cardFixture({ id: '31', name: '温感按摩油' })]),
  }),
};

describe('商品列表', () => {
  beforeEach(() => {
    useSession.setState({ session: { status: 'idle' } });
    useAppConfigStore.setState({ config: appConfigFixture, source: 'network' });
  });

  it('titles itself after the category and lists its subtree', async () => {
    taroFake.routerParams = { categoryId: '12' };
    const seen = serveApi(routes);

    await renderPage(<ProductList />);

    expect(await screen.findByText('柔雾丝绒礼盒')).toBeTruthy();
    expect(screen.getByTestId('navigation-bar').getAttribute('data-title')).toBe('护理');
    expect(lists(seen)).toEqual([{ pageSize: '20', page: '1', categoryIds: '12,121' }]);
  });

  it('lists the products a coupon covers, by its template id', async () => {
    taroFake.routerParams = { couponId: '3' };
    const seen = serveApi(routes);

    await renderPage(<ProductList />);

    expect(await screen.findByText('柔雾丝绒礼盒')).toBeTruthy();
    expect(lists(seen)).toEqual([{ pageSize: '20', page: '1', couponId: '3' }]);
    expect(screen.queryByText(/适用范围/)).toBeNull();
  });

  it('sorts, flips the price order and filters by price', async () => {
    taroFake.routerParams = { keyword: '礼盒' };
    const seen = serveApi(routes);
    await renderPage(<ProductList />);
    await screen.findByText('柔雾丝绒礼盒');

    fireEvent.click(screen.getByRole('button', { name: '销量' }));
    await waitFor(() => expect(lists(seen).at(-1)).toMatchObject({ sortBy: 'sales' }));
    fireEvent.click(screen.getByRole('button', { name: '价格' }));
    await waitFor(() => expect(lists(seen).at(-1)).toMatchObject({ sortOrder: 'asc' }));
    fireEvent.click(screen.getByRole('button', { name: '价格从低到高' }));
    await waitFor(() =>
      expect(lists(seen).at(-1)).toMatchObject({ sortBy: 'price', sortOrder: 'desc' }),
    );

    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    fireEvent.change(screen.getByPlaceholderText('最低价'), { target: { value: '100' } });
    fireEvent.change(screen.getByPlaceholderText('最高价'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() =>
      expect(lists(seen).at(-1)).toMatchObject({
        keyword: '礼盒',
        priceFrom: '30.00',
        priceTo: '100.00',
      }),
    );
  });

  it('switches to one column and remembers it', async () => {
    serveApi(routes);
    await renderPage(<ProductList />);
    await screen.findByText('柔雾丝绒礼盒');

    fireEvent.click(screen.getByRole('button', { name: '切换为单列' }));

    expect(screen.getByRole('button', { name: '切换为双列' })).toBeTruthy();
    expect(taroFake.storage.get('shop.productList.layout')).toBe('list');
  });

  it('opens search in its place, carrying the keyword', async () => {
    taroFake.routerParams = { keyword: '礼盒' };
    serveApi(routes);
    await renderPage(<ProductList />);

    fireEvent.click(screen.getByRole('link', { name: '礼盒' }));

    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'redirectTo',
        args: { url: '/packages/goods/search/index?keyword=%E7%A4%BC%E7%9B%92' },
      }),
    );
  });

  it('says nothing matched a keyword', async () => {
    taroFake.routerParams = { keyword: '不存在' };
    serveApi({ 'GET /api/v1/catalog/products': () => ({ body: pageOf([]) }) });
    await renderPage(<ProductList />);
    expect(await screen.findByText('没有找到「不存在」相关的商品')).toBeTruthy();
  });
});
