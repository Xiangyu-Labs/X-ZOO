import type { InputOf, RouteId } from './types';

/**
 * Deep-sorts object keys and drops `undefined`, so two structurally equal
 * inputs give byte-identical query keys whatever their property order.
 */
export function stableInput(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return (value as unknown[]).map(stableInput);
  const out: Record<string, unknown> = {};
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    const normalised = stableInput(record[key]);
    if (normalised !== undefined) out[key] = normalised;
  }
  return out;
}

/** `[routeId]`: matches every cached read of a route, whatever its input. */
export type RouteKeyPrefix<K extends RouteId = RouteId> = readonly [K];
/** `[routeId, input]`: one cached read. `input` is normalised; `{}` when there is none. */
export type RouteQueryKey<K extends RouteId = RouteId> = readonly [K, Partial<InputOf<K>>];
/** `[routeId, input, 'infinite']`: a paged list read page by page; `input.query` has no `page`. */
export type InfiniteRouteQueryKey<K extends RouteId = RouteId> = readonly [
  K,
  Partial<InputOf<K>>,
  'infinite',
];

/**
 * The query key of one read: `[routeId, { params?, query?, body? }]`.
 *
 * The first element is always the route id, which is the whole convention:
 * `invalidateRoutes(queryClient, 'cart.list')` refreshes every cached read of
 * that route, and a mutation's `invalidate: ['cart.list', 'cart.count']` does
 * the same.
 */
export function routeQueryKey<K extends RouteId>(
  id: K,
  input?: InputOf<K> | undefined,
): RouteQueryKey<K> {
  return [id, stableInput(input ?? {}) as Partial<InputOf<K>>] as const;
}

/** The prefix that matches every cached read of a route. */
export function routeKey<K extends RouteId>(id: K): RouteKeyPrefix<K> {
  return [id] as const;
}
