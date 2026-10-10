import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAdmin } from '@/test/render';

import { NO_BRAND, type AdminBrand } from './brand';
import { BrandProvider } from './brand-context';
import { BRAND_RED } from './brand-mark';

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

describe('<AdminShell> brand', () => {
  const logos: AdminBrand = {
    logo: '/uploads/logo.png',
    square: '/uploads/square.png',
    favicon: null,
  };

  function renderWith(brand: AdminBrand) {
    return renderAdmin(
      <BrandProvider brand={brand}>
        <AdminShell>内容</AdminShell>
      </BrandProvider>,
      { identity: superAdmin },
    );
  }

  /** The link at the top of the sider, home to 首页. */
  function brandLink(container: HTMLElement): HTMLElement {
    const link = container.querySelector('.ant-layout-sider a[href="/admin"]');
    if (!(link instanceof HTMLElement)) throw new Error('侧栏顶部没有品牌链接');
    return link;
  }

  it('shows 后台 Logo instead of the mark and the name while expanded', () => {
    const { container } = renderWith(logos);
    const link = brandLink(container);
    expect(link.querySelector('img')).toHaveAttribute('src', '/uploads/logo.png');
    expect(link.querySelector(`rect[fill="${BRAND_RED}"]`)).toBeNull();
    expect(link).not.toHaveTextContent('商城管理后台');
  });

  it('shows 方形 Logo while collapsed', () => {
    window.localStorage.setItem('admin.sider.collapsed', '1');
    const { container } = renderWith(logos);
    expect(brandLink(container).querySelector('img')).toHaveAttribute('src', '/uploads/square.png');
  });

  it('falls back to the mark, with the name while expanded, for a logo that is not set', async () => {
    const { container } = renderWith(NO_BRAND);
    const link = brandLink(container);
    expect(link.querySelector('img')).toBeNull();
    expect(link.querySelector(`rect[fill="${BRAND_RED}"]`)).not.toBeNull();
    expect(link).toHaveTextContent('商城管理后台');

    await userEvent.click(screen.getByRole('button', { name: '收起菜单' }));
    expect(brandLink(container).querySelector('img')).toBeNull();
    expect(brandLink(container).querySelector(`rect[fill="${BRAND_RED}"]`)).not.toBeNull();
    expect(brandLink(container)).not.toHaveTextContent('商城管理后台');
  });
});
