import type { RouteInput } from './call-route';
import type { AnyRouteDef } from './contracts';

/**
 * Deep-sorts objects and drops `undefined` so that two structurally equal
 * inputs produce byte-identical keys regardless of property order.
 */
export function stableInput(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableInput);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const normalised = stableInput((value as Record<string, unknown>)[key]);
    if (normalised !== undefined) out[key] = normalised;
  }
  return out;
}

/**
 * Query key for one call: `[route.id, { params, query }]`.
 *
 * The first element is always `route.id`, which is what makes
 * `invalidate: [someRoute]` work — see `routeKeyPrefix`.
 */
export function routeQueryKey<R extends AnyRouteDef>(
  route: R,
  input?: RouteInput<R>,
): readonly unknown[] {
  const normalised = stableInput({
    params: input?.params,
    query: input?.query,
    body: input?.body,
  }) as Record<string, unknown>;
  return Object.keys(normalised).length > 0 ? [route.id, normalised] : [route.id];
}

/** Matches every cached call of a route, whatever its input. */
export function routeKeyPrefix(route: AnyRouteDef): readonly unknown[] {
  return [route.id];
}
