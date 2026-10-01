import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

import { presentApiError } from './error-presenter';
import { ApiError } from './errors';

/** `meta` both hooks understand. Anything else you put in `meta` is ignored. */
export interface RouteCallMeta extends Record<string, unknown> {
  /** `false` silences the global toast for this call. Default `true`. */
  presentError?: boolean | undefined;
}

function shouldPresent(meta: unknown): boolean {
  return (meta as RouteCallMeta | undefined)?.presentError !== false;
}

/** Retry GETs on transport/5xx only; never retry a 4xx, never retry a mutation. */
function retryQuery(failureCount: number, error: unknown): boolean {
  if (!ApiError.is(error)) return false;
  if (error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function createAdminQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: retryQuery,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
    queryCache: new QueryCache({
      onError(error, query) {
        if (shouldPresent(query.meta)) presentApiError(error);
      },
    }),
    mutationCache: new MutationCache({
      onError(error, _variables, _onMutateResult, mutation) {
        if (shouldPresent(mutation.meta)) presentApiError(error);
      },
    }),
  });
}
