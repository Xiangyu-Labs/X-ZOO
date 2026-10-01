import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import { AdminProviders } from '@/admin/providers';
import { THEME_COOKIE_KEY, type ThemeMode } from '@/admin/theme/tokens';

/** The consent screen looks like the console it signs into: same providers as `app/admin/layout.tsx`. */
export default async function AuthorizeLayout({ children }: { children: ReactNode }) {
  const raw = (await cookies()).get(THEME_COOKIE_KEY)?.value;
  const initialThemeMode: ThemeMode = raw === 'dark' ? 'dark' : 'light';
  return <AdminProviders initialThemeMode={initialThemeMode}>{children}</AdminProviders>;
}
