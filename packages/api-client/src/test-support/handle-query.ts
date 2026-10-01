/**
 * A verbatim copy of `searchParamsToObject` from `apps/web/src/server/handle.ts`,
 * which a package cannot import (it drags in the whole server). `url.test.ts`
 * fails when the original stops matching this copy, so the query serialiser is
 * always tested against the parser the server really runs.
 */
/** Repeated keys become arrays, so `?tag=a&tag=b` reaches a `z.array` schema. */
export function searchParamsToObject(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}
