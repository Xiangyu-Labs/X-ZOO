import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAdmin } from '@/test/render';

/**
 * The sider: a collapsed one still opens its groups (as hover popups), and the
 * expanded one follows the page — arriving somewhere from outside the menu
 * opens that page's group.
 */

const navigation = vi.hoisted(() => ({ pathname: '/admin' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));
vi.mock('../theme/theme-provider', () => ({
  useThemeMode: () => ({ mode: 'light', setMode: vi.fn(), toggle: vi.fn(), palette: {} }),
}));
vi.mock('../notifications/notification-bell', () => ({ NotificationBell: () => null }));

const { AdminShell } = await import('./admin-shell');

const superAdmin = { id: '1', account: 'root', name: '超级管理员', isSuper: true, permissions: [] };

/** The `<li>` of a top-level group, found by its title. */
function group(label: string): HTMLElement {
  const title = screen.getAllByText(label).find((node) => node.closest('.ant-menu-submenu-title'));
  const item = title?.closest('li.ant-menu-submenu');
  if (!(item instanceof HTMLElement)) throw new Error(`没有「${label}」分组`);
  return item;
}

const isOpen = (label: string): boolean => group(label).classList.contains('ant-menu-submenu-open');

beforeEach(() => {
  window.localStorage.clear();
  navigation.pathname = '/admin';
});

describe('<AdminShell> sider', () => {
  it('opens a group as a popup while collapsed', async () => {
    window.localStorage.setItem('admin.sider.collapsed', '1');
    renderAdmin(<AdminShell>内容</AdminShell>, { identity: superAdmin });

    expect(screen.getByRole('button', { name: '展开菜单' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '售后单' })).not.toBeInTheDocument();

    const title = group('交易').querySelector('.ant-menu-submenu-title');
    if (!title) throw new Error('没有分组标题');
    await userEvent.hover(title);

    expect(await screen.findByRole('link', { name: '售后单' })).toBeInTheDocument();
  });

  it('remembers the collapse choice', async () => {
    renderAdmin(<AdminShell>内容</AdminShell>, { identity: superAdmin });
    await userEvent.click(screen.getByRole('button', { name: '收起菜单' }));
    expect(window.localStorage.getItem('admin.sider.collapsed')).toBe('1');
  });

  it('keeps one group open, and opens the page group after navigating', async () => {
    const { rerender } = renderAdmin(<AdminShell>内容</AdminShell>, { identity: superAdmin });

    await userEvent.click(screen.getByText('交易'));
    await waitFor(() => expect(isOpen('交易')).toBe(true));

    await userEvent.click(screen.getByText('订单'));
    await waitFor(() => expect(isOpen('订单')).toBe(true));
    expect(isOpen('交易')).toBe(false);

    // Arriving at 售后单 from a dashboard tile, not through the menu.
    navigation.pathname = '/admin/trade/refunds';
    act(() => rerender(<AdminShell>售后单页</AdminShell>));
    await waitFor(() => expect(isOpen('交易')).toBe(true));
  });
});
