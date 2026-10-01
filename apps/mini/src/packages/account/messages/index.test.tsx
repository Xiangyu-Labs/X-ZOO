import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { page, signIn } from '@/test/account-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import MessagesPage from './index';

const shipped = {
  id: '5001',
  code: 'order_shipped',
  title: '您的订单已发货',
  content: '订单已由 顺丰速运 发出。',
  data: { orderId: '1024', route: { route: 'order', params: { id: '1024' } } },
  readAt: null,
  createdAt: '2026-09-20T10:00:00+08:00',
};
const notice = {
  id: '5002',
  code: null,
  title: '国庆发货安排',
  content: '10 月 1 日至 3 日暂停发货。',
  data: null,
  readAt: '2026-09-21T10:00:00+08:00',
  createdAt: '2026-09-19T10:00:00+08:00',
};

describe('消息中心', () => {
  beforeEach(() => signIn());

  it('opens a message with a route on that page and marks it read', async () => {
    const seen = serveApi({
      'GET /api/v1/my-messages': () => ({ body: page([shipped, notice]) }),
      'GET /api/v1/my-messages/unread-count': () => ({ body: { unread: 1 } }),
      'POST /api/v1/my-messages/5001/read': () => ({ body: { marked: 1 } }),
    });
    await renderPage(<MessagesPage />);

    fireEvent.click(await screen.findByRole('link', { name: '未读，您的订单已发货' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: '/packages/order/detail/index?id=1024' },
      }),
    );
    await waitFor(() =>
      expect(seen.map((r) => r.key)).toContain('POST /api/v1/my-messages/5001/read'),
    );
  });

  it('opens a message without a route on its detail page', async () => {
    serveApi({
      'GET /api/v1/my-messages': () => ({ body: page([notice]) }),
      'GET /api/v1/my-messages/unread-count': () => ({ body: { unread: 0 } }),
    });
    await renderPage(<MessagesPage />);

    fireEvent.click(await screen.findByRole('link', { name: '国庆发货安排' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: '/packages/account/message/index?id=5002' },
      }),
    );
    expect(screen.queryByRole('button', { name: '全部已读' })).toBeNull();
  });

  it('marks everything read, and deletes a message after asking', async () => {
    const seen = serveApi({
      'GET /api/v1/my-messages': () => ({ body: page([shipped, notice]) }),
      'GET /api/v1/my-messages/unread-count': () => ({ body: { unread: 1 } }),
      'POST /api/v1/my-messages/read-all': () => ({ body: { marked: 1 } }),
      'DELETE /api/v1/my-messages/5002': () => ({ status: 204, body: null }),
    });
    await renderPage(<MessagesPage />);

    expect(await screen.findByText('1 条未读')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '全部已读' }));
    await waitFor(() =>
      expect(seen.map((r) => r.key)).toContain('POST /api/v1/my-messages/read-all'),
    );

    fireEvent.click(screen.getByRole('button', { name: '删除「国庆发货安排」' }));
    await waitFor(() =>
      expect(seen.map((r) => r.key)).toContain('DELETE /api/v1/my-messages/5002'),
    );
  });
});
