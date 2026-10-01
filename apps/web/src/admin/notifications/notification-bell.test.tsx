import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderAdmin } from '@/test/render';

import { NotificationBell } from './notification-bell';

const push = vi.fn();
const markRead = vi.fn();

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('./use-notification-stream', () => ({
  useNotificationStream: () => ({
    notifications: [
      {
        id: 'n1',
        type: 'refund.requested',
        title: '新的售后申请',
        body: '订单 E2E00000002 申请退款',
        link: '/admin/trade/refunds',
        createdAt: '2026-10-01T09:00:00+08:00',
      },
    ],
    unreadCount: 1,
    status: 'open',
    markRead,
    markAllRead: vi.fn(),
  }),
}));

describe('<NotificationBell>', () => {
  it('opens what a notification is about from anywhere on its row, and closes the panel', async () => {
    renderAdmin(<NotificationBell />);
    await userEvent.click(screen.getByTestId('notification-bell'));
    const popup = () => document.querySelector('.ant-dropdown');
    expect(popup()).not.toHaveClass('ant-dropdown-hidden');
    // The body, not the title: the whole row is the target.
    await userEvent.click(await screen.findByText('订单 E2E00000002 申请退款'));

    expect(markRead).toHaveBeenCalledWith('n1');
    expect(push).toHaveBeenCalledWith('/admin/trade/refunds');
    // Leaving: jsdom never finishes the motion that would hide it.
    await waitFor(() => expect(popup()).toHaveClass('ant-slide-up-leave'));
  });
});
