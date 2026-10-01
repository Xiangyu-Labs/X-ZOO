import { errorBody, type ErrorBody } from './contracts';

/**
 * Every failure that leaves `callRoute` is an `ApiError`, including transport
 * failures (`status: 0`). Pages branch on `code`, never on `message`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(init: { status: number; code: string; message: string; details?: unknown }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
  }

  /** 422 field errors as `{ fieldPath: message }`, or `null` if this isn't one. */
  get fieldErrors(): Record<string, string> | null {
    return parseFieldErrors(this.details);
  }

  static is(value: unknown): value is ApiError {
    return value instanceof ApiError;
  }
}

/**
 * What to tell the operator about a failure: the server's words (every `ApiError`
 * is Chinese, transport failures included), or `fallback` for anything else — a
 * `TypeError` from a render or a hand-written queryFn is English, and goes to the
 * console instead. The admin twin of the mini's `errorMessage`.
 */
export function errorMessage(error: unknown, fallback = '操作失败，请稍后再试'): string {
  if (ApiError.is(error)) return error.message || fallback;
  if (error) console.warn(fallback, error);
  return fallback;
}

/** Transport-level codes that never come from the server. */
export const CLIENT_ERROR_CODES = {
  network: 'NETWORK_ERROR',
  parse: 'RESPONSE_PARSE_FAILED',
  schema: 'RESPONSE_SCHEMA_MISMATCH',
  aborted: 'REQUEST_ABORTED',
} as const;

const STATUS_FALLBACK_MESSAGE: Record<number, string> = {
  400: '请求有误',
  401: '请先登录',
  403: '没有权限执行此操作',
  404: '资源不存在',
  409: '操作冲突，请刷新后重试',
  422: '提交的数据有误',
  429: '操作过于频繁，请稍后再试',
  500: '服务器开小差了，请稍后再试',
  502: '服务暂时不可用，请稍后再试',
  503: '服务暂时不可用，请稍后再试',
};

/**
 * Turns whatever the server sent on a non-2xx into an `ApiError`. A body that
 * does not match `errorBody` is not trusted for anything but a status fallback.
 */
export function toApiError(status: number, payload: unknown): ApiError {
  const parsed = errorBody.safeParse(payload);
  if (parsed.success) {
    const body: ErrorBody = parsed.data;
    return new ApiError({
      status,
      code: body.code,
      message: body.message,
      details: body.details,
    });
  }
  return new ApiError({
    status,
    code: `HTTP_${status}`,
    message: STATUS_FALLBACK_MESSAGE[status] ?? '请求失败，请稍后再试',
  });
}

/**
 * Normalises the shapes a 422 `details` may take into `{ path: message }`:
 * - `[{ field: 'a.0.b', message }]`         (what `handle()` sends)
 * - `{ fieldErrors: { name: ['必填'] } }`  (zod `flatten()`)
 * - `[{ path: ['a', 0, 'b'], message }]`    (zod `issues`)
 *
 * The first message for a path wins. `handle()`'s `<body>` entry (a body that
 * is not JSON) names no field, so it is left out.
 *
 * Any other object is not field errors. A domain error's `details` is for the
 * program (`{ reason: 'duplicate-name' }`, `{ channel: 'wechatMini' }`, a
 * permission code), and read as `{ field: message }` its values reached the
 * banner and the toast as they were.
 */
export function parseFieldErrors(details: unknown): Record<string, string> | null {
  if (!details || typeof details !== 'object') return null;

  if (Array.isArray(details)) {
    const out: Record<string, string> = {};
    for (const issue of details) {
      if (!issue || typeof issue !== 'object') continue;
      const rec = issue as { field?: unknown; path?: unknown; message?: unknown };
      const path =
        typeof rec.field === 'string'
          ? rec.field
          : Array.isArray(rec.path)
            ? rec.path.join('.')
            : undefined;
      if (!path || path === '<body>' || typeof rec.message !== 'string') continue;
      if (!(path in out)) out[path] = rec.message;
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  const rec = details as Record<string, unknown>;
  const nested = rec['fieldErrors'];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(nested as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
      else if (Array.isArray(value) && typeof value[0] === 'string') out[key] = value[0];
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  if (Array.isArray(rec['issues'])) {
    return parseFieldErrors(rec['issues']);
  }
  return null;
}
