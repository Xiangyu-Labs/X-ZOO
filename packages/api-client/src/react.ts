/**
 * `@shop/api-client/react`: TanStack Query v5 hooks over an `ApiClient`.
 *
 * Mirrors the admin's `useRouteQuery` / `useRouteMutation`
 * (`apps/web/src/admin/api/hooks.ts`), keyed by route **id** instead of the
 * route object, because the storefront never holds a contract at run time.
 *
 * Query keys: `[routeId, input]` for a read, `[routeId, input, 'infinite']`
 * for a paged list read page by page, where `input` is the normalised
 * `{ params?, query?, body? }` (keys sorted, `undefined` dropped; `{}` when
 * there is none). The route id first is the whole convention: `[routeId]`
 * matches every cached read of a route, which is what `invalidateRoutes` and a
 * mutation's `invalidate` use.
 *
 * Works with React 18 (Taro) and 19 (the admin); uses nothing newer than 18.
 */
import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type UseInfiniteQueryOptions,
  type UseInfiniteQueryResult,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';
import { createContext, createElement, useCallback, useContext, type ReactNode } from 'react';
import type { ApiClient, CallOptions } from './client';
import type { ApiError } from './errors';
import {
  routeKey,
  routeQueryKey,
  stableInput,
  type InfiniteRouteQueryKey,
  type RouteQueryKey,
} from './query-keys';
import type {
  ErrorCodeOf,
  InputOf,
  PagedRouteId,
  PagedShape,
  PartInputOf,
  RequiresInput,
  ResponseOf,
  RouteId,
} from './types';

export {
  routeKey,
  routeQueryKey,
  stableInput,
  type InfiniteRouteQueryKey,
  type RouteKeyPrefix,
  type RouteQueryKey,
} from './query-keys';

/** What a call of route `K` rejects with, `code` narrowed to the route's declared codes. */
export type RouteError<K extends RouteId> = ApiError<ErrorCodeOf<K>>;

// ---------------------------------------------------------------------------
// The client in context
// ---------------------------------------------------------------------------

const ApiClientContext = createContext<ApiClient | null>(null);

/** Puts the app's one `ApiClient` in context, inside `QueryClientProvider`. */
export function ApiClientProvider(props: { client: ApiClient; children?: ReactNode }): ReactNode {
  return createElement(ApiClientContext.Provider, { value: props.client }, props.children);
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (!client) throw new Error('useApiClient: 缺少 <ApiClientProvider>');
  return client;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** `(id)` when the route needs no input, `(id, input)` when it does; options last. */
export type RouteArgs<K extends RouteId, O> =
  RequiresInput<K> extends true
    ? [input: InputOf<K>, options?: O]
    : [input?: InputOf<K> | undefined, options?: O];

export interface RouteQueryExtras {
  /** Extra headers for this read (the abort signal is TanStack's). */
  call?: Omit<CallOptions, 'signal'> | undefined;
}

export type UseRouteQueryOptions<K extends RouteId, TData = ResponseOf<K>> = Omit<
  UseQueryOptions<ResponseOf<K>, RouteError<K>, TData, RouteQueryKey<K>>,
  'queryKey' | 'queryFn'
> &
  RouteQueryExtras;

function callFor<K extends RouteId>(
  client: ApiClient,
  id: K,
  input: InputOf<K> | undefined,
  options: CallOptions,
): Promise<ResponseOf<K>> {
  // `CallArgs<K>` is a conditional tuple TypeScript cannot resolve for a
  // generic `K`; every caller here has already typed `input` as `InputOf<K>`.
  const call = client.call as (
    id: RouteId,
    input: unknown,
    options: CallOptions,
  ) => Promise<ResponseOf<K>>;
  return call(id, input, options);
}

/**
 * Query options for one read, for `useQuery`, `useSuspenseQuery`,
 * `queryClient.prefetchQuery` or `ensureQueryData`. The key carries the
 * response type, so `queryClient.getQueryData(opts.queryKey)` is typed.
 *
 * ```ts
 * await queryClient.prefetchQuery(routeQueryOptions(client, 'catalog.productDetail', { params: { id } }));
 * ```
 */
export function routeQueryOptions<K extends RouteId, TData = ResponseOf<K>>(
  client: ApiClient,
  id: K,
  ...args: RouteArgs<K, UseRouteQueryOptions<K, TData>>
) {
  const [input, options] = args as [InputOf<K> | undefined, UseRouteQueryOptions<K, TData>?];
  const { call, ...rest } = options ?? {};
  return queryOptions<ResponseOf<K>, RouteError<K>, TData, RouteQueryKey<K>>({
    ...rest,
    queryKey: routeQueryKey(id, input),
    queryFn: ({ signal }) => callFor(client, id, input, { ...call, signal }),
  });
}

/**
 * Reads a route.
 *
 * ```tsx
 * const { data, isPending } = useRouteQuery('catalog.productDetail', { params: { id } });
 * const count = useRouteQuery('cart.count', undefined, { enabled: signedIn });
 * ```
 */
export function useRouteQuery<K extends RouteId, TData = ResponseOf<K>>(
  id: K,
  ...args: RouteArgs<K, UseRouteQueryOptions<K, TData>>
): UseQueryResult<TData, RouteError<K>> {
  const client = useApiClient();
  return useQuery(routeQueryOptions<K, TData>(client, id, ...args));
}

// ---------------------------------------------------------------------------
// Paged lists, page by page
// ---------------------------------------------------------------------------

type QueryWithoutPage<K extends RouteId> = Omit<NonNullable<PartInputOf<K, 'query'>>, 'page'>;

/** A paged route's input without `query.page`, which the hook owns. */
export type InfiniteInputOf<K extends PagedRouteId> = Omit<InputOf<K>, 'query'> & {
  query?: QueryWithoutPage<K> | undefined;
};

export type InfiniteRouteArgs<K extends PagedRouteId, O> =
  {} extends InfiniteInputOf<K>
    ? [input?: InfiniteInputOf<K> | undefined, options?: O]
    : [input: InfiniteInputOf<K>, options?: O];

export type UseInfiniteRouteQueryOptions<K extends PagedRouteId> = Omit<
  UseInfiniteQueryOptions<
    ResponseOf<K>,
    RouteError<K>,
    InfiniteData<ResponseOf<K>, number>,
    InfiniteRouteQueryKey<K>,
    number
  >,
  'queryKey' | 'queryFn' | 'initialPageParam' | 'getNextPageParam'
> &
  RouteQueryExtras;

/** The page after `last`, or `undefined` once `page * pageSize` reaches `total`. */
export function nextPageOf(last: PagedShape): number | undefined {
  if (last.items.length === 0) return undefined;
  return last.page * last.pageSize < last.total ? last.page + 1 : undefined;
}

/**
 * Query options for a paged list read page by page, for `useInfiniteQuery` or
 * `queryClient.prefetchInfiniteQuery`: the key and page logic `useInfiniteRouteQuery` uses,
 * so a prefetch lands in the cache entry the hook reads.
 *
 * ```ts
 * void queryClient.prefetchInfiniteQuery(
 *   infiniteRouteQueryOptions(client, 'catalog.productList', { query: { categoryIds, pageSize: 20 } }),
 * );
 * ```
 */
export function infiniteRouteQueryOptions<K extends PagedRouteId>(
  client: ApiClient,
  id: K,
  ...args: InfiniteRouteArgs<K, UseInfiniteRouteQueryOptions<K>>
) {
  const [input, options] = args as [
    InfiniteInputOf<K> | undefined,
    UseInfiniteRouteQueryOptions<K>?,
  ];
  const { call, ...rest } = options ?? {};
  const queryKey = [
    id,
    stableInput(input ?? {}) as Partial<InputOf<K>>,
    'infinite',
  ] as const satisfies InfiniteRouteQueryKey<K>;

  return infiniteQueryOptions<
    ResponseOf<K>,
    RouteError<K>,
    InfiniteData<ResponseOf<K>, number>,
    InfiniteRouteQueryKey<K>,
    number
  >({
    ...rest,
    queryKey,
    initialPageParam: 1,
    getNextPageParam: (last) => nextPageOf(last as PagedShape),
    queryFn: ({ pageParam, signal }) => {
      const query = { ...input?.query, page: pageParam };
      return callFor(client, id, { ...input, query } as unknown as InputOf<K>, { ...call, signal });
    },
  });
}

/**
 * A `paged(...)` list read page by page, for 上拉加载更多. Pages start at 1;
 * `fetchNextPage()` asks for `page + 1` until `page * pageSize >= total`.
 *
 * ```tsx
 * const list = useInfiniteRouteQuery('catalog.productList', { query: { categoryId, pageSize: 20 } });
 * const products = flattenPages(list.data);
 * useReachBottom(() => list.hasNextPage && list.fetchNextPage());
 * ```
 */
export function useInfiniteRouteQuery<K extends PagedRouteId>(
  id: K,
  ...args: InfiniteRouteArgs<K, UseInfiniteRouteQueryOptions<K>>
): UseInfiniteQueryResult<InfiniteData<ResponseOf<K>, number>, RouteError<K>> {
  const client = useApiClient();
  return useInfiniteQuery(infiniteRouteQueryOptions<K>(client, id, ...args));
}

/** Every item of every loaded page, in order. */
export function flattenPages<T>(
  data: InfiniteData<{ items: readonly T[] }, unknown> | undefined,
): T[] {
  const out: T[] = [];
  for (const page of data?.pages ?? []) out.push(...page.items);
  return out;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** What `mutate` takes: the route's input, or nothing when it needs none. */
export type MutationInputOf<K extends RouteId> =
  RequiresInput<K> extends true ? InputOf<K> : InputOf<K> | void;

export type UseRouteMutationOptions<K extends RouteId> = Omit<
  UseMutationOptions<ResponseOf<K>, RouteError<K>, MutationInputOf<K>>,
  'mutationFn'
> & {
  /** Routes whose cached reads go stale once this succeeds, e.g. `['cart.list', 'cart.count']`. */
  invalidate?: readonly RouteId[] | undefined;
  call?: Omit<CallOptions, 'signal'> | undefined;
};

/**
 * Writes through a route. On success it invalidates the listed routes' reads
 * (awaited, so `onSuccess` sees fresh data being fetched), then runs yours.
 *
 * ```tsx
 * const add = useRouteMutation('cart.addItem', { invalidate: ['cart.list', 'cart.count'] });
 * add.mutate({ body: { skuId, quantity: 1 } });
 * ```
 */
export function useRouteMutation<K extends RouteId>(
  id: K,
  options: UseRouteMutationOptions<K> = {},
): UseMutationResult<ResponseOf<K>, RouteError<K>, MutationInputOf<K>> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { invalidate, call, onSuccess, ...rest } = options;

  return useMutation<ResponseOf<K>, RouteError<K>, MutationInputOf<K>>({
    ...rest,
    mutationFn: (input) => callFor(client, id, (input ?? undefined) as InputOf<K>, { ...call }),
    async onSuccess(...successArgs) {
      if (invalidate && invalidate.length > 0) {
        await invalidateRoutes(queryClient, ...invalidate);
      }
      await onSuccess?.(...successArgs);
    },
  });
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

/**
 * Marks every cached read of the given routes stale and refetches the active
 * ones: plain reads and page-by-page lists alike, whatever their input.
 *
 * ```ts
 * await invalidateRoutes(queryClient, 'order.list', 'order.counts');
 * ```
 *
 * To drop one read only, invalidate its full key:
 * `queryClient.invalidateQueries({ queryKey: routeQueryKey('order.detail', { params: { id } }) })`.
 */
export async function invalidateRoutes(
  queryClient: QueryClient,
  ...ids: readonly RouteId[]
): Promise<void> {
  await Promise.all(ids.map((id) => queryClient.invalidateQueries({ queryKey: routeKey(id) })));
}

/** `invalidateRoutes` bound to the context's `QueryClient`. */
export function useInvalidateRoutes(): (...ids: readonly RouteId[]) => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    (...ids: readonly RouteId[]) => invalidateRoutes(queryClient, ...ids),
    [queryClient],
  );
}
