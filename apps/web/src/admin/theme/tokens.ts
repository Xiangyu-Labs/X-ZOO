import type { ThemeConfig } from 'antd';

export type ThemeMode = 'light' | 'dark';

/**
 * The single place the admin's look is defined. Pages never hard-code colours;
 * they use these tokens through antd components or `theme.useToken()`.
 */
export const seedToken = {
  colorPrimary: '#1677ff',
  colorInfo: '#1677ff',
  colorSuccess: '#52c41a',
  colorWarning: '#faad14',
  colorError: '#ff4d4f',
  borderRadius: 6,
  fontSize: 14,
  wireframe: false,
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif",
} as const satisfies ThemeConfig['token'];

/** Shared component tweaks; the shell reads `layout` for its own chrome. */
export const componentTokens: NonNullable<ThemeConfig['components']> = {
  Layout: {
    headerHeight: 56,
    headerPadding: '0 16px',
  },
  Menu: {
    itemMarginInline: 8,
  },
  Table: {
    cellPaddingBlock: 12,
  },
  Form: {
    itemMarginBottom: 20,
  },
  Card: {
    bodyPadding: 20,
  },
};

/** Non-antd surface colours used by the shell (sider, content background). */
export const shellPalette: Record<
  ThemeMode,
  { siderBg: string; contentBg: string; headerBg: string; border: string }
> = {
  light: {
    siderBg: '#ffffff',
    contentBg: '#f5f6f8',
    headerBg: '#ffffff',
    border: 'rgba(5, 5, 5, 0.06)',
  },
  dark: {
    siderBg: '#141414',
    contentBg: '#000000',
    headerBg: '#141414',
    border: 'rgba(253, 253, 253, 0.12)',
  },
};

export const THEME_STORAGE_KEY = 'shop-admin-theme';
export const THEME_COOKIE_KEY = 'shop-admin-theme';
