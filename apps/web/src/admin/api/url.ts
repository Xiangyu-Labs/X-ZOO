/** Value kinds the query serialiser understands. */
export type QueryPrimitive = string | number | boolean | Date | null | undefined;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[] | Record<string, unknown>;

const PLACEHOLDER = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Substitutes `:name` placeholders in a contract path.
 * Throws when a placeholder has no value — a missing id is a programming error,
 * not something to send to the server as the literal string `":id"`.
 */
export function buildPath(path: string, params?: Record<string, unknown> | undefined): string {
  return path.replace(PLACEHOLDER, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null || value === '') {
      throw new Error(`缺少路径参数 :${name}（${path}）`);
    }
    return encodeURIComponent(String(value));
  });
}

function pushPrimitive(sp: URLSearchParams, key: string, value: QueryPrimitive): void {
  if (value === undefined || value === null) return;
  if (value instanceof Date) {
    sp.append(key, value.toISOString());
    return;
  }
  if (typeof value === 'boolean') {
    sp.append(key, value ? 'true' : 'false');
    return;
  }
  const str = String(value);
  // Conventions: absent optional values are omitted, never `""`.
  if (str === '') return;
  sp.append(key, str);
}

/**
 * Serialises a contract query object.
 * - `undefined` / `null` / `""` are omitted
 * - arrays repeat the key (`?ids=1&ids=2`)
 * - `Date` becomes an ISO instant
 * - anything else object-shaped is JSON-encoded
 * - keys are sorted so the same input always produces the same URL (stable cache keys)
 */
export function serialiseQuery(query?: Record<string, unknown> | undefined): string {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (Array.isArray(value)) {
      for (const item of value) pushPrimitive(sp, key, item as QueryPrimitive);
    } else if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      sp.append(key, JSON.stringify(value));
    } else {
      pushPrimitive(sp, key, value as QueryPrimitive);
    }
  }
  const str = sp.toString();
  return str ? `?${str}` : '';
}

/** Full request URL for a route: `baseUrl + path(params) + query`. */
export function buildUrl(
  baseUrl: string,
  path: string,
  params?: Record<string, unknown> | undefined,
  query?: Record<string, unknown> | undefined,
): string {
  return `${baseUrl}${buildPath(path, params)}${serialiseQuery(query)}`;
}
