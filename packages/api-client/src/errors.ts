import type { ClientErrorCode, ErrorCodeOf, RouteId } from './types';

export interface ApiErrorInit<C extends string = string> {
  status: number;
  code: C;
  message: string;
  details?: unknown;
  routeId?: string | undefined;
}

/**
 * Every failure a call rejects with, transport failures included (`status: 0`).
 *
 * Branch on `code`, never on `message`; `message` is Simplified Chinese and
 * safe to show. `code` is a plain `string` here; `isApiError(error, routeId)`
 * narrows it to the codes that route's contract declares.
 */
export class ApiError<C extends string = string> extends Error {
  readonly status: number;
  readonly code: C;
  readonly details: unknown;
  /** The route that failed, for logs. */
  readonly routeId: string | undefined;
  /** Survives a transpiler that breaks `instanceof` on `Error` subclasses (ES5 class lowering). */
  readonly isApiError = true as const;

  constructor(init: ApiErrorInit<C>) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.routeId = init.routeId;
  }

  /**
   * A 422's field errors as `{ field: message }`, or `null` when this is not
   * one. Reads the shape `handle()` sends (`[{ field, message }]`), and zod
   * `issues` (`[{ path, message }]`) for the client's own schema mismatch.
   */
  get fieldErrors(): Record<string, string> | null {
    return parseFieldErrors(this.details);
  }
}

/**
 * `true` for an `ApiError`. Given the route id it came from, narrows `code` to
 * that route's declared codes, so a typo in `error.code === 'CART_…'` is a
 * compile error:
 *
 * ```ts
 * catch (error) {
 *   if (isApiError(error, 'cart.addItem') && error.code === 'CART_ITEM_UNAVAILABLE') …
 * }
 * ```
 */
export function isApiError<K extends RouteId>(
  value: unknown,
  routeId: K,
): value is ApiError<ErrorCodeOf<K>>;
export function isApiError(value: unknown): value is ApiError;
export function isApiError(value: unknown, routeId?: string): value is ApiError {
  if (value instanceof ApiError) return routeId === undefined || value.routeId === routeId;
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<ApiError>;
  return (
    v.isApiError === true &&
    typeof v.status === 'number' &&
    typeof v.code === 'string' &&
    (routeId === undefined || v.routeId === routeId)
  );
}

export const CLIENT_ERROR_CODES = {
  network: 'NETWORK_ERROR',
  aborted: 'REQUEST_ABORTED',
  parse: 'RESPONSE_PARSE_FAILED',
  schema: 'RESPONSE_SCHEMA_MISMATCH',
  method: 'METHOD_UNSUPPORTED',
} as const satisfies Record<string, ClientErrorCode>;

const STATUS_FALLBACK_MESSAGE: Readonly<Record<number, string>> = {
  400: '请求有误',
  401: '请先登录',
  403: '没有权限执行此操作',
  404: '资源不存在',
  405: '请求方式不被支持',
  409: '操作冲突，请刷新后重试',
  413: '上传的内容太大了',
  422: '提交的数据有误',
  429: '操作过于频繁，请稍后再试',
  500: '服务器开小差了，请稍后再试',
  502: '服务暂时不可用，请稍后再试',
  503: '服务暂时不可用，请稍后再试',
  504: '服务器响应超时，请稍后再试',
};

/**
 * A non-2xx into an `ApiError`. A body that is not `{ code, message }` (a
 * gateway's HTML page, an empty 502) is trusted for nothing but the status:
 * the code becomes `HTTP_<status>` and the message a generic one.
 *
 * Hand-rolled rather than `errorBody.safeParse`, so the main entry stays free
 * of zod.
 */
export function toApiError(status: number, payload: unknown, routeId?: string): ApiError {
  if (typeof payload === 'object' && payload !== null) {
    const body = payload as Record<string, unknown>;
    if (typeof body['code'] === 'string' && typeof body['message'] === 'string') {
      return new ApiError({
        status,
        code: body['code'],
        message: body['message'],
        details: body['details'],
        routeId,
      });
    }
  }
  return new ApiError({
    status,
    code: `HTTP_${status}`,
    message: STATUS_FALLBACK_MESSAGE[status] ?? '请求失败，请稍后再试',
    routeId,
  });
}

/**
 * `details` into `{ field: message }`. Understands:
 * - `[{ field: 'items.0.quantity', message }]`, what `handle()` and the mock send;
 * - `[{ path: ['items', 0, 'quantity'], message }]`, zod issues;
 * - `{ fieldErrors: {...} }` and a flat `{ name: message }` map.
 * The first message per field wins.
 */
export function parseFieldErrors(details: unknown): Record<string, string> | null {
  if (typeof details !== 'object' || details === null) return null;
  const out: Record<string, string> = {};

  if (Array.isArray(details)) {
    for (const entry of details as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const rec = entry as { field?: unknown; path?: unknown; message?: unknown };
      const field =
        typeof rec.field === 'string'
          ? rec.field
          : Array.isArray(rec.path)
            ? (rec.path as unknown[]).map(String).join('.')
            : undefined;
      if (field !== undefined && typeof rec.message === 'string' && !(field in out)) {
        out[field] = rec.message;
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  const rec = details as Record<string, unknown>;
  if (typeof rec['fieldErrors'] === 'object' && rec['fieldErrors'] !== null) {
    return parseFieldErrors(rec['fieldErrors']);
  }
  for (const key of Object.keys(rec)) {
    const value = rec[key];
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value) && typeof value[0] === 'string') out[key] = value[0];
  }
  return Object.keys(out).length > 0 ? out : null;
}
