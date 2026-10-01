'use client';

import {
  ApiOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoonOutlined,
  SunOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Avatar, Button, Dropdown, Grid, Layout, Menu, Tooltip, Typography } from 'antd';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useMemo, useState, type ReactNode } from 'react';

import { useStoredFlag } from '../kit/stored-flag';
import { menuRegistry } from '../menu/menu.gen';
import { renderMenuIcon } from '../menu/icons';
import type { MenuNode } from '../menu/types';
import { useAdminMenu } from '../menu/use-admin-menu';
import { NotificationBell } from '../notifications/notification-bell';
import { ForbiddenResult } from '../session/can';
import { useCan, useSession } from '../session/session-provider';
import { useThemeMode } from '../theme/theme-provider';
import { BrandMark } from './brand-mark';
import { requiredPermissions } from './route-permission';
import { SITE_TITLE } from '@/admin/site-title';

const SIDER_WIDTH = 216;

/** The avatar menu's 个人资料. The page lives under 系统; `/admin/profile` is a 404. */
export const PROFILE_PATH = '/admin/system/profile';

/** The avatar menu's API 令牌 — hidden from the sider, see `system.menu.ts`. */
export const API_TOKENS_PATH = '/admin/system/api-tokens';

/**
 * The route-level guard every page gets from the shell: a URL whose
 * menu entry needs an atom the admin lacks renders the 403 inside the chrome
 * instead of an empty screen and a toast per failed fetch. The atoms come from
 * the menu registry — see `route-permission.ts`.
 */
export function RouteGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/admin';
  const can = useCan();
  const required = useMemo(() => requiredPermissions(menuRegistry, pathname), [pathname]);
  if (!required.every((permission) => can(permission))) return <ForbiddenResult />;
  return <>{children}</>;
}
const SIDER_COLLAPSED = 56;

function toMenuItems(nodes: readonly MenuNode[]): NonNullable<Parameters<typeof Menu>[0]['items']> {
  return nodes.map((node) => {
    const icon = renderMenuIcon(node.icon);
    if (node.children?.length) {
      return {
        key: node.key,
        label: node.label,
        ...(icon ? { icon } : {}),
        children: toMenuItems(node.children),
      };
    }
    return {
      key: node.key,
      ...(icon ? { icon } : {}),
      label: node.path ? <Link href={node.path}>{node.label}</Link> : node.label,
    };
  });
}

/**
 * The admin chrome: collapsible sider driven by the permission-filtered menu
 * registry, a header with the notification bell, the theme toggle and the user
 * menu, and a content area.
 *
 * Breadcrumbs are not here — `PageContainer` owns them, so a page can override
 * them for records the menu knows nothing about.
 */
export function AdminShell({ children }: { children: ReactNode }) {
  const { identity, logout, loggingOut } = useSession();
  const can = useCan();
  const { mode, toggle } = useThemeMode();
  const { items, selectedKeys, openKeys } = useAdminMenu();
  const router = useRouter();
  const pathname = usePathname() ?? '/admin';
  const screens = Grid.useBreakpoint();

  // Tablet and below default to collapsed; once the operator touches the
  // toggle their choice wins, and survives a reload.
  const [collapsedPreference, setCollapsedPreference] = useStoredFlag('admin.sider.collapsed');
  const isNarrow = screens.lg === false;
  const collapsed = collapsedPreference ?? isNarrow;

  // Two open-key sets, because a collapsed sider is a different menu: its
  // groups are hover popups. Pinning those to `[]` (as the inline set must be
  // while collapsed) is what made every group unreachable.
  //
  // The inline set belongs to the page it was chosen on: arriving somewhere
  // else (a dashboard tile, the bell, a breadcrumb) opens that page's group.
  const [inlineChoice, setInlineChoice] = useState<{ path: string; keys: string[] } | null>(null);
  const [popupOpenKeys, setPopupOpenKeys] = useState<string[]>([]);
  const inlineOpenKeys =
    inlineChoice && inlineChoice.path === pathname ? inlineChoice.keys : openKeys;

  const topLevelKeys = useMemo(() => new Set(items.map((node) => node.key)), [items]);
  const onOpenChange = useCallback(
    (keys: string[]) => {
      if (collapsed) {
        setPopupOpenKeys(keys);
        return;
      }
      // Accordion: opening one top-level group closes the others.
      const opened = keys.find((key) => !inlineOpenKeys.includes(key));
      const next =
        opened && topLevelKeys.has(opened)
          ? keys.filter((key) => key === opened || !topLevelKeys.has(key))
          : keys;
      setInlineChoice({ path: pathname, keys: next });
    },
    [collapsed, inlineOpenKeys, topLevelKeys, pathname],
  );

  const menuItems = useMemo(() => toMenuItems(items), [items]);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsedPreference}
        trigger={null}
        width={SIDER_WIDTH}
        collapsedWidth={SIDER_COLLAPSED}
        // Always antd's light *variant*: under the dark algorithm it follows the
        // tokens, where `theme="dark"` would paint antd's own navy instead.
        theme="light"
        style={{
          position: 'sticky',
          top: 0,
          height: '100vh',
          borderInlineEnd: '1px solid var(--ant-color-border-secondary)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <Link
            href="/admin"
            style={{
              display: 'flex',
              alignItems: 'center',
              flex: 'none',
              gap: 8,
              height: 56,
              padding: '0 16px',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
            }}
          >
            <BrandMark />
            {collapsed ? null : (
              <Typography.Text strong style={{ fontSize: 15 }}>
                {SITE_TITLE}
              </Typography.Text>
            )}
          </Link>

          {/* Only the menu scrolls; the brand stays put above a long menu. */}
          <div className="admin-scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <Menu
              mode="inline"
              theme="light"
              items={menuItems}
              selectedKeys={selectedKeys}
              openKeys={collapsed ? popupOpenKeys : inlineOpenKeys}
              onOpenChange={onOpenChange}
              style={{ borderInlineEnd: 0 }}
            />
          </div>
        </div>
      </Layout.Sider>

      <Layout>
        <Layout.Header
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            background: 'var(--ant-color-bg-container)',
            borderBottom: '1px solid var(--ant-color-border-secondary)',
            paddingInline: 12,
          }}
        >
          <Button
            type="text"
            aria-label={collapsed ? '展开菜单' : '收起菜单'}
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsedPreference(!collapsed)}
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <NotificationBell />

            <Tooltip title={mode === 'dark' ? '切换到浅色' : '切换到深色'}>
              <Button
                type="text"
                aria-label="切换主题"
                data-testid="theme-toggle"
                icon={mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
                onClick={toggle}
              />
            </Tooltip>

            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  {
                    key: 'account',
                    disabled: true,
                    label: `${identity.name}（${identity.account}）`,
                  },
                  { type: 'divider' },
                  { key: 'profile', icon: <UserOutlined />, label: '个人资料' },
                  ...(can('auth:api-token:self')
                    ? [{ key: 'api-tokens', icon: <ApiOutlined />, label: 'API 令牌' }]
                    : []),
                  {
                    key: 'logout',
                    icon: <LogoutOutlined />,
                    danger: true,
                    label: loggingOut ? '退出中…' : '退出登录',
                  },
                ],
                onClick: ({ key }) => {
                  if (key === 'logout') logout();
                  if (key === 'profile') router.push(PROFILE_PATH);
                  if (key === 'api-tokens') router.push(API_TOKENS_PATH);
                },
              }}
            >
              <Button type="text" style={{ paddingInline: 8 }} data-testid="user-menu">
                <Avatar
                  size={24}
                  {...(identity.avatar ? { src: identity.avatar } : {})}
                  icon={<UserOutlined />}
                />
                {screens.sm === false ? null : (
                  <span style={{ marginInlineStart: 8 }}>{identity.name}</span>
                )}
              </Button>
            </Dropdown>
          </div>
        </Layout.Header>

        <Layout.Content
          style={{
            padding: screens.md === false ? 12 : 20,
            background: 'var(--ant-color-bg-layout)',
            minHeight: 0,
          }}
        >
          <RouteGuard>{children}</RouteGuard>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
