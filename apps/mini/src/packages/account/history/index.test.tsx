import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { page, productFixture, signIn } from '@/test/account-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import HistoryPage from './index';

const other = { ...productFixture, id: '12', name: '竹纤维浴巾' };
const third = { ...productFixture, id: '13', name: '收纳盒' };

describe('浏览记录', () => {
  beforeEach(() => signIn());

  it('groups the rows by day', async () => {
    serveApi({
      'GET /api/v1/me/history': () => ({
        body: page([
          { product: productFixture, available: true, viewedAt: '2026-09-23T20:00:00+08:00' },
          { product: other, available: true, viewedAt: '2026-09-23T09:00:00+08:00' },
          { product: third, available: true, viewedAt: '2026-09-21T09:00:00+08:00' },
        ]),
      }),
    });
    await renderPage(<HistoryPage />);

    expect(await screen.findByText('2026.09.23')).toBeTruthy();
    expect(screen.getAllByText(/^2026\.09\.2\d$/).map((node) => node.textContent)).toEqual([
      '2026.09.23',
      '2026.09.21',
    ]);
  });

  it('clears everything after a confirmation', async () => {
    const seen = serveApi({
      'GET /api/v1/me/history': () => ({
        body: page([
          { product: productFixture, available: true, viewedAt: '2026-09-23T20:00:00+08:00' },
        ]),
      }),
      'DELETE /api/v1/me/history': () => ({ status: 204, body: null }),
    });
    await renderPage(<HistoryPage />);

    fireEvent.click(await screen.findByRole('button', { name: '清空' }));

    await waitFor(() => expect(seen.map((r) => r.key)).toContain('DELETE /api/v1/me/history'));
  });
});
