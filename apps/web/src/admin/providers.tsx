'use client';

// Side-effect import: zod speaks plain Chinese in the console too.
import '@shop/contracts/locale';
import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiFeedbackBridge } from './api/error-presenter';
import { createAdminQueryClient } from './api/query-client';
import { AdminThemeProvider } from './theme/theme-provider';
import type { ThemeMode } from './theme/tokens';

/**
 * Everything under `/admin` runs inside these, login page included.
 * Session loading is deliberately *not* here — it belongs to the shell layout,
 * so the login page can render without a session.
 */
export function AdminProviders({
  initialThemeMode,
  children,
}: {
  initialThemeMode?: ThemeMode | undefined;
  children: ReactNode;
}) {
  // One client per browser tab; `useState` keeps it stable across re-renders
  // and avoids sharing a cache between requests during SSR.
  const [queryClient] = useState(createAdminQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <AdminThemeProvider {...(initialThemeMode ? { initialMode: initialThemeMode } : {})}>
        <ApiFeedbackBridge />
        {children}
      </AdminThemeProvider>
    </QueryClientProvider>
  );
}
