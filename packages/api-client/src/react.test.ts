// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, version, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createApiClient } from './client';
import {
  ApiClientProvider,
  flattenPages,
  infiniteRouteQueryOptions,
  invalidateRoutes,
  nextPageOf,
  routeKey,
  routeQueryKey,
  useInfiniteRouteQuery,
  useRouteMutation,
  useRouteQuery,
} from './react';
import { fakeTransport, json } from './test-support/fake-transport';
import { act, renderHook, waitFor } from './test-support/render-hook';
import type { TransportRequest, TransportResponse } from './transport';

function setup(respond: (request: TransportRequest) => TransportResponse) {
  const fake = fakeTransport(respond);
  const client = createApiClient({
    baseUrl: 'https://shop.example',
    transport: fake.transport,
    platform: 'h5',
    clientVersion: 'test',
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ApiClientProvider, { client }, children),
    );
  const hits = (path: string) => fake.requests.filter((r) => r.url.includes(path)).length;
  return { wrapper, client, queryClient, requests: fake.requests, hits };
}

describe(`hooks on React ${version}`, () => {
  it('run on the React the project picked', () => {
    // `unit` runs React 19 (the admin's), `unit-react18` React 18 (Taro's).
    expect(version).toMatch(/^1[89]\./);
  });
});

describe('query keys', () => {
  it('are [routeId, input], normalised so property order and undefined do not matter', () => {
    expect(
      routeQueryKey('catalog.productList', {
        query: { pageSize: 20, page: 1, keyword: undefined },
      }),
    ).toEqual(['catalog.productList', { query: { page: 1, pageSize: 20 } }]);
    expect(routeQueryKey('catalog.productList', { query: { page: 1, pageSize: 20 } })).toEqual(
      routeQueryKey('catalog.productList', { query: { pageSize: 20, page: 1 } }),
    );
    expect(routeQueryKey('cart.count')).toEqual(['cart.count', {}]);
    expect(routeKey('cart.count')).toEqual(['cart.count']);
  });
});

describe('useRouteQuery', () => {
  it('reads a route under its [routeId, input] key', async () => {
    const { wrapper, queryClient, requests } = setup(() => json(200, { id: '7', name: '商品' }));
    const { result } = renderHook(
      () => useRouteQuery('catalog.productDetail', { params: { id: '7' } }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe('7');
    expect(requests[0]?.url).toBe('https://shop.example/api/v1/catalog/products/7');
    expect(
      queryClient.getQueryData(routeQueryKey('catalog.productDetail', { params: { id: '7' } })),
    ).toEqual({ id: '7', name: '商品' });
  });

  it('surfaces a failure as the ApiError', async () => {
    const { wrapper } = setup(() =>
      json(404, { code: 'CATALOG_PRODUCT_NOT_FOUND', message: '商品不存在' }),
    );
    const { result } = renderHook(
      () => useRouteQuery('catalog.productDetail', { params: { id: '404' } }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ status: 404, code: 'CATALOG_PRODUCT_NOT_FOUND' });
  });
});

describe('useInfiniteRouteQuery', () => {
  const pageOf = (request: TransportRequest) => {
    const page = Number(/[?&]page=(\d+)/.exec(request.url)?.[1]);
    const items =
      page === 3 ? [{ id: '5' }] : [{ id: String(page * 2 - 1) }, { id: String(page * 2) }];
    return json(200, { items, total: 5, page, pageSize: 2 });
  };

  it('asks for page 1, then page + 1, and stops at total', async () => {
    const { wrapper, requests } = setup(pageOf);
    const { result } = renderHook(
      () => useInfiniteRouteQuery('catalog.productList', { query: { pageSize: 2, keyword: '茶' } }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    await act(() => result.current.fetchNextPage());
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(3));
    expect(result.current.hasNextPage).toBe(false);
    expect(flattenPages(result.current.data).map((p) => p.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(requests.map((r) => r.url.split('?')[1])).toEqual([
      'keyword=%E8%8C%B6&page=1&pageSize=2',
      'keyword=%E8%8C%B6&page=2&pageSize=2',
      'keyword=%E8%8C%B6&page=3&pageSize=2',
    ]);
  });

  it('fills, through infiniteRouteQueryOptions, the entry the hook reads (a prefetch)', async () => {
    const { wrapper, client, queryClient, requests } = setup(pageOf);
    // The app's staleTime: a copy just fetched is not asked for again on mount.
    queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
    const input = { query: { keyword: '茶', pageSize: 2 } };
    await queryClient.prefetchInfiniteQuery(
      infiniteRouteQueryOptions(client, 'catalog.productList', input),
    );
    expect(requests).toHaveLength(1);

    const { result } = renderHook(
      // Property order does not matter: the key is normalised the same way.
      () => useInfiniteRouteQuery('catalog.productList', { query: { pageSize: 2, keyword: '茶' } }),
      { wrapper },
    );
    expect(result.current.isSuccess).toBe(true);
    expect(flattenPages(result.current.data).map((p) => p.id)).toEqual(['1', '2']);
    await act(() => result.current.fetchNextPage());
    expect(requests.map((r) => r.url.split('?')[1])).toEqual([
      'keyword=%E8%8C%B6&page=1&pageSize=2',
      'keyword=%E8%8C%B6&page=2&pageSize=2',
    ]);
  });

  it('stops on an empty page even if total says otherwise', () => {
    expect(nextPageOf({ items: [], total: 99, page: 1, pageSize: 20 })).toBeUndefined();
    expect(nextPageOf({ items: [1], total: 21, page: 1, pageSize: 20 })).toBe(2);
    expect(nextPageOf({ items: [1], total: 20, page: 1, pageSize: 20 })).toBeUndefined();
  });
});

describe('useRouteMutation', () => {
  it('writes, then refreshes the reads of every route it names', async () => {
    const { wrapper, hits } = setup((request) =>
      request.method === 'POST'
        ? json(201, { item: {}, cart: {} })
        : json(200, { items: 1, quantity: 1, availableCount: 1, unavailableCount: 0 }),
    );
    const { result } = renderHook(
      () => ({
        count: useRouteQuery('cart.count'),
        add: useRouteMutation('cart.addItem', { invalidate: ['cart.count'] }),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.count.isSuccess).toBe(true));
    expect(hits('/cart/count')).toBe(1);

    await act(() => result.current.add.mutateAsync({ body: { skuId: '21', quantity: 1 } }));
    await waitFor(() => expect(hits('/cart/count')).toBe(2));
    expect(hits('/cart/items')).toBe(1);
  });

  it('invalidateRoutes refreshes plain and page-by-page reads of a route alike', async () => {
    const { wrapper, queryClient, hits } = setup(() =>
      json(200, { items: [], total: 0, page: 1, pageSize: 20 }),
    );
    const { result } = renderHook(
      () => ({
        plain: useRouteQuery('order.list', { query: { tab: 'all' } }),
        infinite: useInfiniteRouteQuery('order.list'),
      }),
      { wrapper },
    );
    await waitFor(() =>
      expect(result.current.plain.isSuccess && result.current.infinite.isSuccess).toBe(true),
    );
    expect(hits('/orders')).toBe(2);
    await act(() => invalidateRoutes(queryClient, 'order.list'));
    await waitFor(() => expect(hits('/orders')).toBe(4));
  });
});
