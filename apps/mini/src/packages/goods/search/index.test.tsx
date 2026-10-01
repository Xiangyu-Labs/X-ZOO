import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { startSession, useSession } from '@/session/session';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import Search from './index';

const hot = {
  'GET /api/v1/catalog/search/hot-keywords': () => ({
    body: { items: [{ keyword: '按摩油', count: 12 }] },
  }),
};
const listUrl = (keyword: string) =>
  `/packages/goods/list/index?keyword=${encodeURIComponent(keyword)}`;

describe('搜索', () => {
  beforeEach(() => useSession.setState({ session: { status: 'idle' } }));

  it('shows hot words to a guest, with no history, and searches one on tap', async () => {
    const seen = serveApi(hot);
    await renderPage(<Search />);

    fireEvent.click(await screen.findByRole('button', { name: '按摩油' }));

    expect(taroFake.calls).toContainEqual({ api: 'redirectTo', args: { url: listUrl('按摩油') } });
    expect(screen.queryByText('搜索历史')).toBeNull();
    expect(seen.some((request) => request.key.includes('search-history'))).toBe(false);
  });

  it('keeps both sections in the tree while the words load, so the keyboard stays up', async () => {
    serveApi(hot);
    const { container } = await renderPage(<Search />);
    const sections = () => container.querySelectorAll('.goods-search__section');
    const before = sections();
    expect(before).toHaveLength(2);
    expect(before[1]?.className).toContain('goods-search__section--hidden');
    await screen.findByRole('button', { name: '按摩油' });
    const after = sections();
    expect(after).toHaveLength(2);
    // The same nodes, not new ones: Taro sends nothing beside the focused search bar.
    expect(after[1]).toBe(before[1]);
    expect(after[1]?.className).not.toContain('--hidden');
    expect(after[0]?.className).toContain('goods-search__section--hidden');
  });

  it('submits the typed keyword in place of this page, and refuses an empty one', async () => {
    taroFake.routerParams = { keyword: '礼盒' };
    serveApi(hot);
    await renderPage(<Search />);

    const input = screen.getByRole('textbox', { name: '搜索商品' });
    expect((input as HTMLInputElement).value).toBe('礼盒');
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    expect(taroFake.calls.some((call) => call.api === 'redirectTo')).toBe(false);

    fireEvent.change(input, { target: { value: ' 丝绒 ' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    expect(taroFake.calls).toContainEqual({ api: 'redirectTo', args: { url: listUrl('丝绒') } });
  });

  it('shows a signed-in shopper’s history and clears it after confirming', async () => {
    taroFake.storage.set('shop.session.token', 't1');
    let history = [{ keyword: '柔雾', searchedAt: '2026-09-20T10:00:00+08:00' }];
    const seen = serveApi({
      ...hot,
      'GET /api/v1/cart/count': () => ({
        body: { items: 0, quantity: 0, availableCount: 0, unavailableCount: 0 },
      }),
      'GET /api/v1/me/search-history': () => ({ body: { items: history } }),
      'DELETE /api/v1/me/search-history': () => {
        history = [];
        return { status: 204, body: null };
      },
    });
    await startSession();
    await renderPage(<Search />);

    expect(await screen.findByRole('button', { name: '柔雾' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '清空搜索历史' }));

    await waitFor(() => expect(screen.queryByText('搜索历史')).toBeNull());
    expect(seen.some((request) => request.key === 'DELETE /api/v1/me/search-history')).toBe(true);
  });

  it('asks for the history again on every visit: the last search added to it', async () => {
    taroFake.storage.set('shop.session.token', 't1');
    const seen = serveApi({
      ...hot,
      'GET /api/v1/cart/count': () => ({
        body: { items: 0, quantity: 0, availableCount: 0, unavailableCount: 0 },
      }),
      'GET /api/v1/me/search-history': () => ({
        body: { items: [{ keyword: '柔雾', searchedAt: '2026-09-20T10:00:00+08:00' }] },
      }),
    });
    await startSession();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 30_000 } },
    });
    const first = await renderPage(<Search />, client);
    expect(await screen.findByRole('button', { name: '柔雾' })).toBeTruthy();
    first.unmount();

    await renderPage(<Search />, client);
    await waitFor(() =>
      expect(seen.filter((r) => r.key === 'GET /api/v1/me/search-history')).toHaveLength(2),
    );
  });
});
