import { ApiError, CLIENT_ERROR_CODES, isApiError, toApiError } from './errors';
import { storefrontRouteList } from './routes.gen';
import type { AbortSignalLike, Transport, TransportResponse } from './transport';
import type {
  ClientPlatform,
  InputOf,
  RequiresInput,
  ResponseOf,
  RouteId,
  RouteMeta,
  RouteMetaOf,
} from './types';
import { buildUrl } from './url';

/**
 * Checks a successful response against its contract. The client never builds
 * one itself: `@shop/api-client/validate` does, from the full contracts, and a
 * development or test build passes it in. Throw (an `ApiError`, ideally) to
 * fail the call.
 */
export type ResponseValidator = (route: RouteMeta, status: number, payload: unknown) => void;

export interface ApiClientOptions {
  /** Origin the `/api/v1/...` paths are appended to, e.g. `https://shop.example`. `''` for same-origin. */
  baseUrl: string;
  transport: Transport;
  /** Sent as `X-Client-Platform`; the server picks the WeChat app and pay channel by it. */
  platform: ClientPlatform;
  /** Sent as `X-Client-Version`, e.g. the mini-program's release version. */
  clientVersion: string;
  /**
   * The shopper's bearer token, or nothing when signed out. Read before each
   * call to a `user` or `user-optional` route; a `public` route never gets it.
   */
  getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /**
   * A 401 happened. Called once per burst: every call already in flight when
   * it fires is covered by that one call, so ten parallel reads with an
   * expired token prompt one login, not ten. A call made after it fired can
   * fire it again. The call still rejects with the `ApiError`.
   */
  onUnauthorized?: (error: ApiError) => void;
  /** See `ResponseValidator`. Leave unset in a production build. */
  validateResponse?: ResponseValidator | undefined;
  /** Passed to the transport; `taroTransport` hands it to `Taro.request`. */
  timeoutMs?: number;
}

export interface CallOptions {
  signal?: AbortSignalLike | undefined;
  /** Extra headers. The client's own (`Authorization`, `X-Client-*`, `Content-Type`) win. */
  headers?: Readonly<Record<string, string>> | undefined;
}

/** `call(id)` when the route needs no input, `call(id, input)` when it does. */
export type CallArgs<K extends RouteId> =
  RequiresInput<K> extends true
    ? [input: InputOf<K>, options?: CallOptions]
    : [input?: InputOf<K> | undefined, options?: CallOptions];

export interface ApiClient {
  /**
   * Calls a storefront route by id. Resolves to the response typed from the
   * contract, or rejects with an `ApiError` (any non-2xx, and any transport
   * failure with `status: 0`).
   *
   * ```ts
   * const page = await client.call('catalog.productList', { query: { page: 1, keyword } });
   * ```
   */
  call<K extends RouteId>(id: K, ...args: CallArgs<K>): Promise<ResponseOf<K>>;
  /** The runtime row for a route id. */
  route<K extends RouteId>(id: K): RouteMetaOf<K>;
  readonly platform: ClientPlatform;
}

/**
 * Methods a body never goes with (`fetch` refuses one). `handle()` reads a body
 * on any other method whose route declares one, DELETE included.
 */
const WITHOUT_BODY = new Set(['GET', 'HEAD']);

let routeIndex: Record<string, RouteMeta> | undefined;

/** The runtime row for a route id; throws for an id that is not a storefront route. */
export function routeMeta<K extends RouteId>(id: K): RouteMetaOf<K> {
  if (!routeIndex) {
    const index: Record<string, RouteMeta> = {};
    for (const route of storefrontRouteList) index[route.id] = route;
    routeIndex = index;
  }
  const meta = routeIndex[id];
  if (!meta) throw new Error(`未知的接口 ${id}`);
  return meta as RouteMetaOf<K>;
}

type LooseInput = {
  params?: Readonly<Record<string, unknown>> | undefined;
  query?: Readonly<Record<string, unknown>> | undefined;
  body?: unknown;
};

export function createApiClient(options: ApiClientOptions): ApiClient {
  const { baseUrl, transport, platform, clientVersion, getToken, onUnauthorized, timeoutMs } =
    options;

  /** Sequence number of the last call sent. */
  let sent = 0;
  /** Calls numbered up to this were in flight when `onUnauthorized` last fired. */
  let unauthorizedCovers = 0;

  function unauthorized(seq: number, error: ApiError): void {
    if (!onUnauthorized || seq <= unauthorizedCovers) return;
    unauthorizedCovers = sent;
    onUnauthorized(error);
  }

  async function call(id: RouteId, rawInput?: unknown, callOptions?: CallOptions) {
    const route = routeMeta(id);
    const input = (rawInput ?? {}) as LooseInput;
    const url = buildUrl(baseUrl, route.path, input.params, input.query);

    const headers: Record<string, string> = {
      ...callOptions?.headers,
      Accept: 'application/json',
      'X-Client-Platform': platform,
      'X-Client-Version': clientVersion,
    };
    if (route.auth !== 'public' && getToken) {
      const token = await getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    let body: string | undefined;
    if (!WITHOUT_BODY.has(route.method) && input.body !== undefined) {
      body = JSON.stringify(input.body);
      headers['Content-Type'] = 'application/json';
    }

    const signal = callOptions?.signal;
    sent += 1;
    const seq = sent;

    let response: TransportResponse;
    try {
      response = await transport({
        url,
        method: route.method,
        headers,
        body,
        signal,
        timeoutMs,
      });
    } catch (cause) {
      if (isApiError(cause)) throw withRoute(cause, id);
      if (signal?.aborted) {
        throw new ApiError({
          status: 0,
          code: CLIENT_ERROR_CODES.aborted,
          message: '请求已取消',
          routeId: id,
        });
      }
      throw new ApiError({
        status: 0,
        code: CLIENT_ERROR_CODES.network,
        message: '网络连接失败，请检查网络后重试',
        details: describe(cause),
        routeId: id,
      });
    }

    const ok = response.status >= 200 && response.status < 300;
    const payload = readPayload(response, ok, id);

    if (!ok) {
      const error = toApiError(response.status, payload, id);
      if (response.status === 401) unauthorized(seq, error);
      throw error;
    }

    options.validateResponse?.(route, response.status, payload);
    return payload;
  }

  return {
    call: call as ApiClient['call'],
    route: routeMeta,
    platform,
  };
}

function readPayload(response: TransportResponse, ok: boolean, routeId: string): unknown {
  if (response.status === 204 || response.status === 205) return undefined;
  if (response.body.length === 0) return undefined;
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    if (!ok) return undefined; // a gateway's HTML error page: `toApiError` falls back to the status
    throw new ApiError({
      status: response.status,
      code: CLIENT_ERROR_CODES.parse,
      message: '服务器返回的数据无法解析',
      routeId,
    });
  }
}

function withRoute(error: ApiError, routeId: string): ApiError {
  if (error.routeId !== undefined) return error;
  return new ApiError({
    status: error.status,
    code: error.code,
    // eslint-disable-next-line weapp/no-raw-error-text -- an ApiError's message: already the server's Chinese
    message: error.message,
    details: error.details,
    routeId,
  });
}

function describe(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'object' && cause !== null) {
    const errMsg = (cause as { errMsg?: unknown }).errMsg; // Taro/wx `fail` result
    if (typeof errMsg === 'string') return errMsg;
  }
  return undefined;
}
