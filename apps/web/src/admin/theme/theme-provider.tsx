'use client';

import { App, ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import {
  componentTokens,
  seedToken,
  shellPalette,
  THEME_COOKIE_KEY,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from './tokens';

dayjs.locale('zh-cn');

export interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
  palette: (typeof shellPalette)[ThemeMode];
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useThemeMode(): ThemeContextValue {
  const ctx = use(ThemeContext);
  if (!ctx) throw new Error('useThemeMode 必须在 <AdminThemeProvider> 内使用');
  return ctx;
}

function readStoredMode(): ThemeMode | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    return null;
  }
}

/**
 * localStorage as an external store.
 *
 * `useSyncExternalStore` is the right shape here: the server snapshot is the
 * cookie-derived mode (so SSR and hydration agree), the client snapshot is what
 * localStorage says, and React reconciles the two without a setState-in-effect.
 * It also picks up a change made in another tab.
 */
const listeners = new Set<() => void>();

function subscribeToStoredMode(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === THEME_STORAGE_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

function persistMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* private mode; the cookie below still carries it across reloads */
  }
  for (const listener of listeners) listener();
  // Mirrored into a cookie purely so the server can render the right theme on
  // the first paint (see `app/admin/layout.tsx`). localStorage stays the store.
  document.cookie = `${THEME_COOKIE_KEY}=${mode}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * A click beside a dialog does not close it. Every dialog here holds something
 * the operator typed or ticked (a form, a picker's selection, a token shown
 * once), and a stray click on the dimmed page lost it. Esc, ✕ and 取消 still
 * close. Drawers keep the default: most of them only show a record.
 */
const MODAL_CONFIG = { mask: { closable: false } } as const;

/**
 * Wraps the admin in antd's `ConfigProvider` (zh_CN, design tokens, light/dark
 * algorithm) and antd's `<App/>` so `message`/`notification`/`Modal` instances
 * inherit theme and locale instead of using the static, context-free versions.
 *
 * `initialMode` comes from the theme cookie, server-side, so there is no flash
 * and no hydration mismatch.
 */
export function AdminThemeProvider({
  initialMode = 'light',
  children,
}: {
  initialMode?: ThemeMode | undefined;
  children: ReactNode;
}) {
  const mode = useSyncExternalStore(
    subscribeToStoredMode,
    () => readStoredMode() ?? initialMode,
    () => initialMode,
  );

  useEffect(() => {
    document.documentElement.dataset['theme'] = mode;
    document.documentElement.style.colorScheme = mode;
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => persistMode(next), []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      setMode,
      toggle: () => setMode(mode === 'dark' ? 'light' : 'dark'),
      palette: shellPalette[mode],
    }),
    [mode, setMode],
  );

  return (
    <ThemeContext value={value}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: seedToken,
          components: componentTokens,
          cssVar: { prefix: 'ant' },
        }}
        modal={MODAL_CONFIG}
      >
        <App component={false}>{children}</App>
      </ConfigProvider>
    </ThemeContext>
  );
}
