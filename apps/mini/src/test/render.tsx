import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';

/** A fresh client per test: no retries, no cache shared between tests. */
export function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

export function renderWithQuery(
  ui: ReactNode,
  client: QueryClient = testQueryClient(),
): RenderResult & { client: QueryClient } {
  const result = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { ...result, client };
}

/** A page as the app renders it: the query client and the `/api/v1` client. */
export async function renderPage(
  ui: ReactNode,
  client: QueryClient = testQueryClient(),
): Promise<RenderResult & { client: QueryClient }> {
  const { ApiClientProvider } = await import('@shop/api-client/react');
  const { api } = await import('@/data/api');
  return renderWithQuery(<ApiClientProvider client={api}>{ui}</ApiClientProvider>, client);
}
