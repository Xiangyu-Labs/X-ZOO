/**
 * Path and query building.
 *
 * Written against the mini-program runtime, which has no `URL` and no
 * `URLSearchParams`: plain string work and `encodeURIComponent` only.
 */

const PLACEHOLDER = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Substitutes the `:name` placeholders of a contract path.
 *
 * A missing value throws: a missing id is a programming error, not something
 * to send to the server as the literal `":id"`.
 */
export function buildPath(path: string, params?: Readonly<Record<string, unknown>>): string {
  return path.replace(PLACEHOLDER, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null || value === '') {
      throw new Error(`缺少路径参数 :${name}（${path}）`);
    }
    return encodeURIComponent(String(value));
  });
}

function scalar(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value);
  // The conventions: an absent optional value is omitted, never `""`.
  return text === '' ? null : text;
}

/**
 * Serialises a query object the way `handle()` reads it back
 * (`searchParamsToObject` in `apps/web/src/server/handle.ts`):
 *
 * - `undefined`, `null` and `""` are left out;
 * - an array repeats its key (`?ids=1&ids=2`), which the server turns back
 *   into an array. A one-element array arrives as a single string, so an array
 *   field in a query schema must accept one; `idList` does, and it also takes
 *   the comma form;
 * - booleans are `true` / `false` (what `z.stringbool()` reads), a `Date` an
 *   ISO instant, any other object JSON;
 * - keys are sorted, so one input always gives one URL.
 */
export function serialiseQuery(query?: Readonly<Record<string, unknown>>): string {
  if (!query) return '';
  const pairs: string[] = [];
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    const values = Array.isArray(value) ? (value as readonly unknown[]) : [value];
    for (const item of values) {
      const text = scalar(item);
      if (text !== null) pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(text)}`);
    }
  }
  return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

/** `baseUrl + path(params) + query`. A trailing `/` on `baseUrl` is dropped. */
export function buildUrl(
  baseUrl: string,
  path: string,
  params?: Readonly<Record<string, unknown>>,
  query?: Readonly<Record<string, unknown>>,
): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${buildPath(path, params)}${serialiseQuery(query)}`;
}
