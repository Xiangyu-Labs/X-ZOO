import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { page, productFixture, signIn } from '@/test/account-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import FavoritesPage from './index';

const other = { ...productFixture, id: '12', name: '竹纤维浴巾' };

describe('我的收藏', () => {
  beforeEach(() => signIn());

  it('lists the favourites and removes the ticked ones in one request', async () => {
    const seen = serveApi({
      'GET /api/v1/me/favorites': () => ({
        body: page([
          { product: productFixture, available: true, createdAt: '2026-09-20T10:00:00+08:00' },
          { product: other, available: true, createdAt: '2026-09-19T10:00:00+08:00' },
        ]),
      }),
      'POST /api/v1/me/favorites/deletions': () => ({ body: { removed: 1 } }),
    });
    await renderPage(<FavoritesPage />);
    expect(await screen.findByRole('link', { name: '纯棉毛巾' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '管理' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 竹纤维浴巾' }));
    fireEvent.click(screen.getByRole('button', { name: '取消收藏（1）' }));

    await waitFor(() =>
      expect(seen.find((r) => r.key === 'POST /api/v1/me/favorites/deletions')?.body).toEqual({
        productIds: ['12'],
      }),
    );
  });

  it('draws a favourite taken off sale as 已下架, and still lets it be removed', async () => {
    const seen = serveApi({
      'GET /api/v1/me/favorites': () => ({
        body: page([
          {
            product: { ...other, stock: 0, canAddToCart: false },
            available: false,
            createdAt: '2026-09-19T10:00:00+08:00',
          },
        ]),
      }),
      'POST /api/v1/me/favorites/deletions': () => ({ body: { removed: 1 } }),
    });
    await renderPage(<FavoritesPage />);
    expect(await screen.findByRole('link', { name: '竹纤维浴巾，已下架' })).toBeTruthy();
    expect(screen.getByText('已下架')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '管理' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 竹纤维浴巾' }));
    fireEvent.click(screen.getByRole('button', { name: '取消收藏（1）' }));
    await waitFor(() =>
      expect(seen.find((r) => r.key === 'POST /api/v1/me/favorites/deletions')?.body).toEqual({
        productIds: ['12'],
      }),
    );
  });

  it('says there is nothing yet', async () => {
    serveApi({ 'GET /api/v1/me/favorites': () => ({ body: page([]) }) });
    await renderPage(<FavoritesPage />);
    expect(await screen.findByText('还没有收藏')).toBeTruthy();
  });
});
