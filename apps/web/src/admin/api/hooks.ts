'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useCallback } from 'react';

import { callRoute, type CallOptions, type RouteInput } from './call-route';
import type { AnyRouteDef, ResponseOf } from './contracts';
import { presentSuccess } from './error-presenter';
import type { ApiError } from './errors';
import { routeKeyPrefix, routeQueryKey } from './query-keys';

type QueryKey = readonly unknown[];

export interface UseRouteQueryOptions<R extends AnyRouteDef> extends Omit<
  UseQueryOptions<ResponseOf<R>, ApiError, ResponseOf<R>, QueryKey>,
  'queryKey' | 'queryFn'
> {
  /** `false` suppresses the global error toast for this query. */
  presentError?: boolean | undefined;
  /** Passed straight through to `callRoute` (e.g. `onUnauthorized: 'throw'`). */
  call?: Omit<CallOptions, 'signal'> | undefined;
}

/**
 * Reads a route. The query key is `[route.id, { params, query }]`, so
 * `useRouteMutation({ invalidate: [thatRoute] })` refreshes every call of it.
 *
 * ```tsx
 * const { data, isPending } = useRouteQuery(couponList, { query: { page, pageSize } });
 * ```
 */
export function useRouteQuery<R extends AnyRouteDef>(
  route: R,
  input?: RouteInput<R>,
  options: UseRouteQueryOptions<R> = {},
): UseQueryResult<ResponseOf<R>, ApiError> {
  const { presentError, call, meta, ...rest } = options;
  return useQuery<ResponseOf<R>, ApiError, ResponseOf<R>, QueryKey>({
    ...rest,
    queryKey: routeQueryKey(route, input),
    queryFn: ({ signal }) => callRoute(route, input, { ...call, signal }),
    meta: { ...meta, presentError: presentError ?? true },
  });
}

export interface UseRouteMutationOptions<R extends AnyRouteDef> extends Omit<
  UseMutationOptions<ResponseOf<R>, ApiError, RouteInput<R>>,
  'mutationFn' | 'meta'
> {
  /** Routes whose cached reads become stale once this mutation succeeds. */
  invalidate?: readonly AnyRouteDef[] | undefined;
  /** Shown with `message.success` on success. */
  successMessage?: string | undefined;
  /** `false` suppresses the global error toast (e.g. the form shows 422 inline). */
  presentError?: boolean | undefined;
  call?: Omit<CallOptions, 'signal'> | undefined;
  meta?: Record<string, unknown> | undefined;
}

/**
 * Writes through a route.
 *
 * ```tsx
 * const save = useRouteMutation(couponCreate, {
 *   invalidate: [couponList],
 *   successMessage: '已创建',
 * });
 * save.mutate({ body: values });
 * ```
 */
export function useRouteMutation<R extends AnyRouteDef>(
  route: R,
  options: UseRouteMutationOptions<R> = {},
): UseMutationResult<ResponseOf<R>, ApiError, RouteInput<R>> {
  const queryClient = useQueryClient();
  const { invalidate, successMessage, presentError, call, onSuccess, meta, ...rest } = options;

  return useMutation<ResponseOf<R>, ApiError, RouteInput<R>>({
    ...rest,
    mutationFn: (input: RouteInput<R>) => callRoute(route, input, { ...call }),
    meta: { ...meta, presentError: presentError ?? true },
    async onSuccess(data, variables, onMutateResult, context) {
      if (invalidate?.length) {
        await Promise.all(
          invalidate.map((target) =>
            queryClient.invalidateQueries({ queryKey: routeKeyPrefix(target) }),
          ),
        );
      }
      if (successMessage) presentSuccess(successMessage);
      await onSuccess?.(data, variables, onMutateResult, context);
    },
  });
}

/** Imperative invalidation for the rare case a mutation cannot express it. */
export function useInvalidateRoutes(): (...routes: AnyRouteDef[]) => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    async (...routes: AnyRouteDef[]) => {
      await Promise.all(
        routes.map((route) => queryClient.invalidateQueries({ queryKey: routeKeyPrefix(route) })),
      );
    },
    [queryClient],
  );
}
