/**
 * `@shop/api-client`: the storefront's typed client for `/api/v1`.
 *
 * Nothing reachable from this entry imports zod or a contract at run time:
 * the contracts type the calls (`import type`) and the generated table
 * (`routes.gen.ts`) carries the four fields a request needs. `bundle.test.ts`
 * holds that line. `storefront-routes.gen.ts`, the page catalogue (route key ->
 * mini-program path, also `@shop/api-client/routes`), is plain data too.
 * Response validation lives in `@shop/api-client/validate`, which this entry
 * never imports.
 */
export { createApiClient, routeMeta } from './client';
export type {
  ApiClient,
  ApiClientOptions,
  CallArgs,
  CallOptions,
  ResponseValidator,
} from './client';
export { ApiError, CLIENT_ERROR_CODES, isApiError, parseFieldErrors, toApiError } from './errors';
export type { ApiErrorInit } from './errors';
export { fetchTransport, taroTransport } from './transport';
export type {
  AbortSignalLike,
  FetchLike,
  TaroRequestLike,
  TaroRequestOption,
  TaroRequestResult,
  TaroRequestTaskLike,
  TaroTransportOptions,
  Transport,
  TransportRequest,
  TransportResponse,
} from './transport';
export { buildPath, buildUrl, serialiseQuery } from './url';
export { storefrontRouteList } from './routes.gen';
export { storefrontRoutes } from './storefront-routes.gen';
export type {
  StorefrontRoute,
  StorefrontRouteEntry,
  StorefrontRouteKey,
  StorefrontRouteParams,
  StorefrontShare,
} from './storefront-routes.gen';
export type {
  ClientErrorCode,
  ClientPlatform,
  CommonErrorCode,
  ContractOf,
  ErrorCodeOf,
  HttpFallbackCode,
  HttpMethod,
  InputOf,
  PageItemOf,
  PagedRouteId,
  PagedShape,
  PartInputOf,
  PartsOf,
  RequiresInput,
  ResponseOf,
  RouteId,
  RouteMeta,
  RouteMetaOf,
} from './types';
