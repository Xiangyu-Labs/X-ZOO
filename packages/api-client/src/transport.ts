import { ApiError, CLIENT_ERROR_CODES } from './errors';
import type { HttpMethod } from './types';

/**
 * The structural part of `AbortSignal` the client uses. The mini-program
 * runtime has no `AbortController` of its own, so nothing here assumes one; a
 * polyfilled or TanStack-provided signal fits.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** One HTTP exchange, already serialised: the URL is final and the body is JSON text. */
export interface TransportRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignalLike | undefined;
  timeoutMs: number | undefined;
}

export interface TransportResponse {
  status: number;
  /** Lower-cased names. */
  headers: Record<string, string>;
  /** The raw body text; `''` when there is none. The client parses it. */
  body: string;
}

/**
 * Sends one request. Resolves for **every** HTTP status; rejects only when no
 * response arrived (network down, aborted, timed out). Throwing an `ApiError`
 * passes it through to the caller unchanged.
 */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

interface FetchResponseLike {
  status: number;
  headers: { forEach(callback: (value: string, key: string) => void): void };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignalLike;
  },
) => Promise<FetchResponseLike>;

/**
 * A transport over `fetch`: for tests (against the mock server) and for a
 * plain H5 page. `timeoutMs` is not applied; pass a signal instead.
 *
 * `fetchImpl` defaults to the global `fetch`, looked up per request so a test
 * can stub it after the client exists.
 */
export function fetchTransport(fetchImpl?: FetchLike): Transport {
  return async (request) => {
    // Tests and H5 only: the mini-program never calls fetchTransport (taroTransport instead).
    // eslint-disable-next-line no-restricted-globals -- see above
    const doFetch = fetchImpl ?? (globalThis as unknown as { fetch?: FetchLike }).fetch;
    if (!doFetch) throw new Error('fetchTransport: 当前环境没有 fetch');
    const init: Parameters<FetchLike>[1] = { method: request.method, headers: request.headers };
    if (request.body !== undefined) init.body = request.body;
    if (request.signal !== undefined) init.signal = request.signal;
    const response = await doFetch(request.url, init);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, headers, body: await response.text() };
  };
}

// ---------------------------------------------------------------------------
// Taro.request
// ---------------------------------------------------------------------------

/** What `taroTransport` passes to `Taro.request`: a subset of `Taro.request.Option`. */
export interface TaroRequestOption {
  url: string;
  method: HttpMethod;
  header: Record<string, string>;
  data?: string;
  /** Anything but `'json'` makes `wx.request` hand the body over unparsed. */
  dataType: string;
  responseType: 'text';
  timeout?: number;
}

/** What `Taro.request(...)` returns: a promise of the result, with `abort()` on it. */
export interface TaroRequestTaskLike {
  then<R1 = TaroRequestResult, R2 = never>(
    onFulfilled?: ((value: TaroRequestResult) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2>;
  abort?(): void;
}

export interface TaroRequestResult {
  statusCode: number;
  header?: Record<string, unknown> | undefined;
  data: unknown;
}

/** `Taro.request` itself, structurally, so this package has no `@tarojs/*` dependency. */
export type TaroRequestLike = (option: TaroRequestOption) => TaroRequestTaskLike;

export interface TaroTransportOptions {
  /**
   * Methods the runtime cannot send. `wx.request` has no `PATCH` (its methods
   * are OPTIONS, GET, HEAD, POST, PUT, DELETE, TRACE, CONNECT), so by default a
   * `PATCH` fails fast with `METHOD_UNSUPPORTED` instead of reaching WeChat.
   * The H5 build can pass `[]`.
   */
  unsupportedMethods?: readonly HttpMethod[];
}

/**
 * A transport over `Taro.request`, which the app passes in:
 *
 * ```ts
 * import Taro from '@tarojs/taro';
 * const transport = taroTransport(Taro.request);
 * ```
 *
 * The body goes out as a JSON string and comes back as text (`dataType` is not
 * `'json'`), so the client parses every response the same way on every
 * platform. A `fail` callback (no response at all) rejects; any HTTP status
 * resolves.
 */
export function taroTransport(
  request: TaroRequestLike,
  options: TaroTransportOptions = {},
): Transport {
  const unsupported = options.unsupportedMethods ?? ['PATCH'];
  return (req) => {
    if (unsupported.indexOf(req.method) !== -1) {
      return Promise.reject(
        new ApiError({
          status: 0,
          code: CLIENT_ERROR_CODES.method,
          message: `当前平台不支持 ${req.method} 请求`,
        }),
      );
    }
    const option: TaroRequestOption = {
      url: req.url,
      method: req.method,
      header: req.headers,
      dataType: 'text',
      responseType: 'text',
    };
    if (req.body !== undefined) option.data = req.body;
    if (req.timeoutMs !== undefined) option.timeout = req.timeoutMs;

    return new Promise<TransportResponse>((resolve, reject) => {
      const signal = req.signal;
      if (signal?.aborted) {
        reject(new Error('request:fail abort'));
        return;
      }
      const task = request(option);
      const onAbort = (): void => task.abort?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      task.then(
        (result) => {
          signal?.removeEventListener('abort', onAbort);
          resolve({
            status: result.statusCode,
            headers: lowerCaseHeaders(result.header),
            body: bodyText(result.data),
          });
        },
        (reason) => {
          signal?.removeEventListener('abort', onAbort);
          reject(reason);
        },
      );
    });
  };
}

function lowerCaseHeaders(header: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const key of Object.keys(header)) {
    const value = header[key];
    if (value !== undefined && value !== null) out[key.toLowerCase()] = String(value);
  }
  return out;
}

/** `dataType: 'text'` gives a string; a runtime that parsed anyway gets re-serialised. */
function bodyText(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') return data;
  return JSON.stringify(data);
}
