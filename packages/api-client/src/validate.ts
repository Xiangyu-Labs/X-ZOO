/**
 * `@shop/api-client/validate`: response validation against the full contracts.
 *
 * This entry imports every contract and zod, which is the whole reason it is
 * separate: the main entry must never import it, and a production mini-program
 * build must not either (zod is ~60 KB minified and compiles its parsers with
 * `new Function` when the runtime allows it). Use it in tests, in the H5 dev
 * server, and in a development mini-program build switched in by the bundler.
 *
 * ```ts
 * import { createApiClient } from '@shop/api-client';
 * import { contractValidator } from '@shop/api-client/validate';
 * const client = createApiClient({ ..., validateResponse: contractValidator() });
 * ```
 */
import { commonErrors, errorBody, type AnyRouteDef } from '@shop/contracts/conventions';
import { errorRegistry } from '@shop/contracts/errors';
import { allRoutes } from '@shop/contracts/routes';
import type { ResponseValidator } from './client';
import { ApiError, CLIENT_ERROR_CODES } from './errors';
import type { RouteId } from './types';

let byId: Map<string, AnyRouteDef> | undefined;

/** The full contract of a storefront route (zod schemas, examples and all). */
export function contractOf(id: RouteId | string): AnyRouteDef {
  byId ??= new Map(allRoutes.map((route) => [route.id, route]));
  const route = byId.get(id);
  if (!route) throw new Error(`未知的接口 ${id}`);
  return route;
}

/**
 * A `ResponseValidator` that parses each 2xx body with the route's `response`
 * schema and fails the call with `RESPONSE_SCHEMA_MISMATCH` (zod issues in
 * `details`) when it does not match. The caller still receives the body as the
 * server sent it, not zod's parsed copy: the types describe the wire.
 */
export function contractValidator(): ResponseValidator {
  return (meta, status, payload) => {
    if (status === 204) return;
    const route = contractOf(meta.id);
    const parsed = route.response.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError({
        status,
        code: CLIENT_ERROR_CODES.schema,
        message: '服务器返回的数据格式有误，请刷新后重试',
        details: parsed.error.issues,
        routeId: meta.id,
      });
    }
  };
}

/** Codes `handle()` may answer on any route, whatever the route lists in `errors`. */
const ALWAYS_POSSIBLE: ReadonlySet<string> = new Set(Object.keys(commonErrors));

/**
 * Why `status` + `body` is an error the route `id` never answers, or `null` when it may: the
 * body must be the error envelope, its code one the route declares (or one any route may
 * give), and the status the one that code is registered under. For test stubs: a test of a
 * failure the server never sends proves nothing (AGENTS.md 20).
 */
export function errorReplyProblem(
  id: RouteId | string,
  status: number,
  body: unknown,
): string | null {
  const route = contractOf(id);
  const parsed = errorBody.safeParse(body);
  if (!parsed.success)
    return `${id}: a ${status} answer is not an error envelope { code, message }`;
  const { code } = parsed.data;
  if (!ALWAYS_POSSIBLE.has(code) && !(route.errors ?? []).includes(code)) {
    return `${id} does not declare ${code} in its errors; the server never answers it there`;
  }
  const registered = errorRegistry[code];
  if (registered !== undefined && registered.status !== status) {
    return `${code} is a ${registered.status}, but the stub for ${id} answered ${status}`;
  }
  return null;
}
