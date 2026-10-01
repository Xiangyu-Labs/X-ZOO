'use client';

import { usePathname } from 'next/navigation';
import { useMemo } from 'react';

import { useCan } from '../session/session-provider';
import { menuRegistry } from './menu.gen';
import { filterMenu, findMenuTrail, menuStateForPath } from './tree';
import type { MenuNode } from './types';

export interface AdminMenuState {
  /** Sider tree: permission-filtered, dev-filtered, hidden nodes removed. */
  items: MenuNode[];
  /** Same filtering minus `hidden`, used to resolve breadcrumbs for detail pages. */
  all: MenuNode[];
  selectedKeys: string[];
  openKeys: string[];
  /** Ancestor chain for the current URL, root first. */
  trail: MenuNode[];
}

/** The menu as the current admin sees it at the current URL. */
export function useAdminMenu(): AdminMenuState {
  const can = useCan();
  const pathname = usePathname() ?? '/admin';
  const includeDev = process.env.NODE_ENV !== 'production';

  return useMemo(() => {
    const items = filterMenu(menuRegistry, { can, includeDev });
    const all = filterMenu(menuRegistry, { can, includeDev, includeHidden: true });
    const { selectedKeys, openKeys } = menuStateForPath(items, pathname);
    return { items, all, selectedKeys, openKeys, trail: findMenuTrail(all, pathname) };
  }, [can, includeDev, pathname]);
}
