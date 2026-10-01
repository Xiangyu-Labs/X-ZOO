import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { signIn } from '@/test/account-fixture';
import { serveApi } from '@/test/fake-api';
import { renderPage } from '@/test/render';
import { taroFake } from '@/test/taro-fake/taro';
import MessagePage from './index';

const message = {
  id: '5001',
  code: 'order_shipped',
  title: '您的订单已发货',
  content: '订单已由 顺丰速运 发出。',
  data: { route: { route: 'order', params: { id: '1024' } } },
  readAt: null,
  createdAt: '2026-09-20T10:00:00+08:00',
};

describe('消息详情', () => {
  beforeEach(() => {
    signIn();
    taroFake.routerParams = { id: '5001' };
  });

  it('shows the message, marks it read once, and opens its page', async () => {
    const seen = serveApi({
      'GET /api/v1/my-messages/5001': () => ({ body: message }),
      'POST /api/v1/my-messages/5001/read': () => ({ body: { marked: 1 } }),
    });
    await renderPage(<MessagePage />);

    expect(await screen.findByText('订单已由 顺丰速运 发出。')).toBeTruthy();
    await waitFor(() =>
      expect(seen.filter((r) => r.key === 'POST /api/v1/my-messages/5001/read')).toHaveLength(1),
    );

    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    await waitFor(() =>
      expect(taroFake.calls).toContainEqual({
        api: 'navigateTo',
        args: { url: '/packages/order/detail/index?id=1024' },
      }),
    );
  });

  it('does not mark a read message again, and has no link without a route', async () => {
    const seen = serveApi({
      'GET /api/v1/my-messages/5001': () => ({
        body: { ...message, data: null, readAt: '2026-09-21T10:00:00+08:00' },
      }),
    });
    await renderPage(<MessagePage />);

    expect(await screen.findByText('您的订单已发货')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '查看详情' })).toBeNull();
    expect(seen.map((r) => r.key)).not.toContain('POST /api/v1/my-messages/5001/read');
  });
});
