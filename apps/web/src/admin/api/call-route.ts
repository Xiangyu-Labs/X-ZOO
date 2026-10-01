import type { z } from 'zod';

import { getApiConfig } from './config';
import type { AnyRouteDef, ResponseOf } from './contracts';
import { ApiError, CLIENT_ERROR_CODES, toApiError } from './errors';
import { buildUrl } from './url';

/**
 * Request side of a route. All three parts are optional on purpose.
 *
 * `defineRoute`'s generics fall back to `z.ZodType` when a route omits
 * `params` / `query` / `body`, so a "required when declared" encoding would
 * make param-less routes demand a `params` key. Optional keys keep call sites
 * honest (the *value* is still fully checked) without that tax.
 *
 * Query and body use `z.input`, so schema defaults and coercions are optional
 * at the call site — exactly what a form produces.
 */
export interface RouteInput<R extends AnyRouteDef> {
  params?: ParamsInputOf<R> | undefined;
  query?: QueryInputOf<R> | undefined;
  body?: BodyInputOf<R> | undefined;
  /**
   * A body already in a wire format, for the one thing JSON cannot express.
   *
   * `multipart/form-data` has to be serialised by the browser — it generates
   * the boundary — so an upload passes `formData` instead of `body` and the
   * request goes out with **no `Content-Type`** header. A multipart route
   * therefore declares no `body` schema and carries its options in `query`,
   * which is how the server half already works: `handle()` parses only JSON
   * bodies. When `formData` is present, `body` is ignored.
   */
  formData?: FormData | undefined;
}

// `NonNullable` matters: with `exactOptionalPropertyTypes`, `RouteDef['params']`
// is `TParams | undefined`, which never satisfies `extends z.ZodType`. (The
// `ParamsOf`/`QueryOf`/`BodyOf` in the contracts conventions miss this and collapse
// to `undefined` for every route.)
export type ParamsInputOf<R extends AnyRouteDef> =
  NonNullable<R['params']> extends z.ZodType ? z.input<NonNullable<R['params']>> : never;
export type QueryInputOf<R extends AnyRouteDef> =
  NonNullable<R['query']> extends z.ZodType ? z.input<NonNullable<R['query']>> : never;
export type BodyInputOf<R extends AnyRouteDef> =
  NonNullable<R['body']> extends z.ZodType ? z.input<NonNullable<R['body']>> : never;

export interface CallOptions {
  signal?: AbortSignal | undefined;
  /**
   * What to do about a 401. `redirect` (default) hands control to
   * `ApiConfig.onUnauthenticated` and still throws; `throw` only throws, which
   * is what the login page and `SessionProvider` want.
   */
  onUnauthorized?: 'redirect' | 'throw' | undefined;
  /** Per-call override of `ApiConfig.validateResponses`. */
  validateResponse?: boolean | undefined;
  /** Extra headers. `Content-Type` and `Accept` are set for you. */
  headers?: Record<string, string> | undefined;
}

const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD', 'DELETE']);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/**
 * The one way the admin UI talks to the server.
 *
 * Builds the URL from the contract path and `input.params`, serialises
 * `input.query`, sends `input.body` as JSON with the session cookie attached,
 * and returns the parsed response typed as `ResponseOf<R>`. Any non-2xx — and
 * any transport failure — throws `ApiError`.
 *
 * Pass `formData` instead of `body` to upload a file; everything after the
 * `fetch` — the `ApiError` mapping, the 401 hook, response validation — is the
 * same code either way, so an upload's 413 reaches the UI looking exactly like
 * any other route's.
 */
export async function callRoute<R extends AnyRouteDef>(
  route: R,
  input?: RouteInput<R>,
  options: CallOptions = {},
): Promise<ResponseOf<R>> {
  const cfg = getApiConfig();
  const url = buildUrl(cfg.baseUrl, route.path, asRecord(input?.params), asRecord(input?.query));

  const formData = input?.formData;
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  const hasBody =
    formData === undefined && !METHODS_WITHOUT_BODY.has(route.method) && input?.body !== undefined;
  // Never `Content-Type` for FormData: the browser sets it, boundary and all.
  if (hasBody) headers['Content-Type'] = 'application/json';

  const init: RequestInit = {
    method: route.method,
    headers,
    credentials: 'include',
    cache: 'no-store',
  };
  if (formData !== undefined) init.body = formData;
  else if (hasBody) init.body = JSON.stringify(input?.body);
  if (options.signal) init.signal = options.signal;

  let response: Response;
  try {
    response = await cfg.fetch(url, init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw new ApiError({ status: 0, code: CLIENT_ERROR_CODES.aborted, message: '请求已取消' });
    }
    throw new ApiError({
      status: 0,
      code: CLIENT_ERROR_CODES.network,
      message: '网络连接失败，请检查网络后重试',
      details: cause instanceof Error ? cause.message : undefined,
    });
  }

  const payload = await readJson(response);

  if (!response.ok) {
    const error = toApiError(response.status, payload);
    if (response.status === 401 && options.onUnauthorized !== 'throw') {
      cfg.onUnauthenticated(error);
    }
    throw error;
  }

  const validate = options.validateResponse ?? cfg.validateResponses;
  if (validate && route.response) {
    const parsed = route.response.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError({
        status: response.status,
        code: CLIENT_ERROR_CODES.schema,
        message: '服务器返回的数据格式有误，请刷新后重试',
        details: { route: route.id, issues: parsed.error.issues },
      });
    }
  }

  return payload as ResponseOf<R>;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (response.ok) {
      throw new ApiError({
        status: response.status,
        code: CLIENT_ERROR_CODES.parse,
        message: '服务器返回的数据无法解析',
      });
    }
    return undefined;
  }
}
