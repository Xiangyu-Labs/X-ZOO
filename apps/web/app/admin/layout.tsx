import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import { AdminProviders } from '@/admin/providers';
import { THEME_COOKIE_KEY, type ThemeMode } from '@/admin/theme/tokens';
import { loadBrand } from '@/server/brand';

/**
 * 站点设置 → 浏览器图标, when set, is the tab icon of every admin page; otherwise
 * the root's `app/icon.svg` stays. (The `.ico` lives in `public/`, not `app/`:
 * Next links an `app/favicon.ico` ahead of every other icon on every page, and
 * the browser would keep showing it.)
 */
export async function generateMetadata(): Promise<Metadata> {
  const { favicon } = await loadBrand();
  return favicon ? { icons: { icon: favicon } } : {};
}

/**
 * Providers for everything under `/admin`, including the login page.
 *
 * The theme is read from a cookie here — `AdminThemeProvider` writes both
 * localStorage (the store of record) and that cookie — so the server renders
 * the right palette and there is neither a flash nor a hydration mismatch.
 * The shop's logos are read here too, for the sidebar and the login card.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const [store, brand] = await Promise.all([cookies(), loadBrand()]);
  const raw = store.get(THEME_COOKIE_KEY)?.value;
  const initialThemeMode: ThemeMode = raw === 'dark' ? 'dark' : 'light';

  return (
    <AdminProviders initialThemeMode={initialThemeMode} brand={brand}>
      {children}
    </AdminProviders>
  );
}
