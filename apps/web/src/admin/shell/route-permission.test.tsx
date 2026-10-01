import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAdmin } from '@/test/render';
import { menuRegistry } from '../menu/menu.gen';
import { isCoveredByMenu, requiredPermissions } from './route-permission';

/**
 * The shell guards every page by the atom its menu entry declares,
 * and the avatar menu's 个人资料 goes to a page that exists.
 */

const navigation = vi.hoisted(() => ({ pathname: '/admin', push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: navigation.push, back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

// The shell's chrome, reduced to what this file looks at.
vi.mock('../theme/theme-provider', () => ({
  useThemeMode: () => ({ mode: 'light', setMode: vi.fn(), toggle: vi.fn(), palette: {} }),
}));
vi.mock('../notifications/notification-bell', () => ({ NotificationBell: () => null }));

// Imported after the mocks so the shell sees them.
const { AdminShell, PROFILE_PATH, RouteGuard } = await import('./admin-shell');

const SHELL_DIR = join(import.meta.dirname, '../../../app/admin/(shell)');

/** Every `page.tsx` under the shell, as the URL it serves. */
function shellPages(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === 'page.tsx') {
        const rel = relative(SHELL_DIR, dir).split('\\').join('/');
        out.push(rel === '' ? '/admin' : `/admin/${rel}`);
      }
    }
  };
  walk(SHELL_DIR);
  return out.sort();
}

/**
 * Pages with no menu entry, compared exactly so a stale entry fails too. The
 * 403 page is where a guard sends people; it must not be guarded itself.
 */
// `[...missing]` is the 404 for any path no page claims: there is nothing behind it to guard.
const UNGUARDED = ['/admin/403', '/admin/[...missing]'];

beforeEach(() => {
  navigation.pathname = '/admin';
  navigation.push.mockReset();
});

describe('requiredPermissions', () => {
  it('reads the atom of the deepest matching menu entry, params included', () => {
    expect(requiredPermissions(menuRegistry, '/admin/system/admins')).toEqual([
      'system:admin:read',
    ]);
    // `[group]` matches one segment.
    expect(requiredPermissions(menuRegistry, '/admin/system/settings/payment')).toContain(
      'system:config:read',
    );
    // A literal segment beats a parameter at the same depth.
    expect(requiredPermissions(menuRegistry, '/admin/orders/invoices')).toEqual([
      'order:invoice:read',
    ]);
    expect(requiredPermissions(menuRegistry, '/admin/orders/12')).toEqual(['order:order:read']);
    // A detail page below a list page inherits the list's atom.
    expect(requiredPermissions(menuRegistry, '/admin/system/audit-logs/anything')).toEqual([
      'system:audit:read',
    ]);
    // 个人资料 needs no grant.
    expect(requiredPermissions(menuRegistry, PROFILE_PATH)).toEqual([]);
    // Unknown URLs are the page's business.
    expect(requiredPermissions(menuRegistry, '/admin/nowhere')).toEqual([]);
  });

  it('covers every page under the shell but the 403 page — a new page needs a menu entry', () => {
    const uncovered = shellPages().filter((path) => !isCoveredByMenu(menuRegistry, path));
    expect(uncovered).toEqual(UNGUARDED);
  });
});

describe('RouteGuard', () => {
  it('renders the 403 inside the chrome for a page outside the role', () => {
    navigation.pathname = '/admin/system/admins';
    renderAdmin(
      <RouteGuard>
        <p>管理员列表</p>
      </RouteGuard>,
      {
        identity: { id: '2', account: 'ops', name: '运营', isSuper: false, permissions: [] },
      },
    );
    expect(screen.queryByText('管理员列表')).toBeNull();
    expect(screen.getByText('抱歉，你没有权限访问该页面。')).toBeTruthy();
  });

  it('renders the page for an admin who holds the atom, and 个人资料 for anybody', () => {
    navigation.pathname = '/admin/system/admins';
    const { unmount } = renderAdmin(
      <RouteGuard>
        <p>管理员列表</p>
      </RouteGuard>,
      {
        identity: {
          id: '2',
          account: 'ops',
          name: '运营',
          isSuper: false,
          permissions: ['system:admin:read'],
        },
      },
    );
    expect(screen.getByText('管理员列表')).toBeTruthy();
    unmount();

    navigation.pathname = PROFILE_PATH;
    renderAdmin(
      <RouteGuard>
        <p>我的资料</p>
      </RouteGuard>,
      { identity: { id: '3', account: 'x', name: 'x', isSuper: false, permissions: [] } },
    );
    expect(screen.getByText('我的资料')).toBeTruthy();
  });
});

describe('the avatar menu', () => {
  it('sends 个人资料 to the page that exists', async () => {
    expect(shellPages()).toContain(PROFILE_PATH);
    renderAdmin(
      <AdminShell>
        <p>content</p>
      </AdminShell>,
    );
    screen.getByTestId('user-menu').click();
    const item = await screen.findByText('个人资料');
    item.click();
    expect(navigation.push).toHaveBeenCalledWith(PROFILE_PATH);
  });
});
