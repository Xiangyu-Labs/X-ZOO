import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import { AdminProviders } from '@/admin/providers';
import { THEME_COOKIE_KEY, type ThemeMode } from '@/admin/theme/tokens';

/**
 * Providers for everything under `/admin`, including the login page.
 *
 * The theme is read from a cookie here — `AdminThemeProvider` writes both
 * localStorage (the store of record) and that cookie — so the server renders
 * the right palette and there is neither a flash nor a hydration mismatch.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const store = await cookies();
  const raw = store.get(THEME_COOKIE_KEY)?.value;
  const initialThemeMode: ThemeMode = raw === 'dark' ? 'dark' : 'light';

  return <AdminProviders initialThemeMode={initialThemeMode}>{children}</AdminProviders>;
}
