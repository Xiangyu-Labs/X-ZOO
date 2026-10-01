/**
 * The client's types, derived from the contracts **at the type level only**.
 *
 * Every import in this file is `import type`: the contracts' zod schemas type
 * each call and are erased by the compiler, so none of them reaches a bundle.
 */
import type { z } from 'zod';
import type { ClientPlatform, commonErrors, HttpMethod } from '@shop/contracts/conventions';
import type {
  StorefrontContracts,
  StorefrontDeclaredErrors,
  StorefrontRouteParts,
  storefrontRouteList,
} from './routes.gen';

export type { ClientPlatform, HttpMethod };

/** Every storefront route id, e.g. `'catalog.productList'`. */
export type RouteId = keyof StorefrontContracts & string;

/** One row of the runtime table: `{ id, method, path, auth }`. */
export type RouteMeta = (typeof storefrontRouteList)[number];
export type RouteMetaOf<K extends RouteId> = Extract<RouteMeta, { id: K }>;

/** The contract behind a route id, e.g. `typeof catalogProductList`. */
export type ContractOf<K extends RouteId> = StorefrontContracts[K];

/** The request parts the route declares: `'params' | 'query' | 'body'`, or `never`. */
export type PartsOf<K extends RouteId> = StorefrontRouteParts[K];

type Part = 'params' | 'query' | 'body';

/**
 * What the caller passes for one part: the schema's `z.input`, so defaults and
 * coercions are optional at the call site, as a form produces them.
 *
 * `defineRoute` infers an omitted part as the bare `z.ZodType` (whose input is
 * `unknown`), so presence is not read from the contract type but from
 * `StorefrontRouteParts`, which the generator writes from the route at run time.
 */
export type PartInputOf<K extends RouteId, P extends Part> =
  P extends PartsOf<K>
    ? NonNullable<ContractOf<K>[P]> extends z.ZodType
      ? z.input<NonNullable<ContractOf<K>[P]>>
      : never
    : undefined;

type PartField<K extends RouteId, P extends Part> =
  P extends PartsOf<K>
    ? {} extends PartInputOf<K, P>
      ? { [Q in P]?: PartInputOf<K, P> | undefined }
      : { [Q in P]: PartInputOf<K, P> }
    : { [Q in P]?: undefined };

type Simplify<T> = { [Key in keyof T]: T[Key] } & {};

/**
 * The second argument of `client.call(id, input)`.
 *
 * A part the route declares is required when its schema has a required key
 * (`params: { id }`), optional when every key is optional or defaulted (a
 * `pageQuery`); a part it does not declare cannot be passed.
 */
export type InputOf<K extends RouteId> = Simplify<
  PartField<K, 'params'> & PartField<K, 'query'> & PartField<K, 'body'>
>;

/** `true` when `client.call(id)` without an input would not typecheck. */
export type RequiresInput<K extends RouteId> = {} extends InputOf<K> ? false : true;

/**
 * What a successful call resolves to.
 *
 * `z.input` of the response schema, not `z.output`: `handle()` serialises what
 * the service returned (typed `z.input<response>`) and only *checks* it against
 * the schema; it never sends the parsed value. So a `.default()` in a response
 * schema can be absent on the wire, and the type says so. For the storefront
 * routes today the two are identical (`types.test.ts` asserts it for the
 * representative set). A 204 route resolves to `undefined`.
 */
export type ResponseOf<K extends RouteId> = z.input<ContractOf<K>['response']>;

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/** Codes any route may answer with, without listing them (`UNAUTHENTICATED`, `VALIDATION_FAILED`, ...). */
export type CommonErrorCode = keyof typeof commonErrors & string;

/** Codes the client itself produces; they never come from the server. */
export type ClientErrorCode =
  | 'NETWORK_ERROR'
  | 'REQUEST_ABORTED'
  | 'RESPONSE_PARSE_FAILED'
  | 'RESPONSE_SCHEMA_MISMATCH'
  | 'METHOD_UNSUPPORTED';

/** A non-2xx whose body was not an `errorBody` (a proxy's 502 page, say): `HTTP_502`. */
export type HttpFallbackCode = `HTTP_${number}`;

/**
 * Every code a call of this route can reject with: the codes its contract
 * lists, the common ones, and the client's own. `isApiError(error, routeId)`
 * narrows `error.code` to this union.
 */
export type ErrorCodeOf<K extends RouteId> =
  StorefrontDeclaredErrors[K] | CommonErrorCode | ClientErrorCode | HttpFallbackCode;

// ---------------------------------------------------------------------------
// Paged lists
// ---------------------------------------------------------------------------

/** The wire shape of `paged(item)` in the contracts' conventions. */
export interface PagedShape {
  items: readonly unknown[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET routes answering `paged(item)` and taking `page` in their query: what `useInfiniteRouteQuery` accepts. */
export type PagedRouteId = {
  [K in RouteId]: RouteMetaOf<K>['method'] extends 'GET'
    ? ResponseOf<K> extends PagedShape
      ? 'query' extends PartsOf<K>
        ? 'page' extends keyof NonNullable<PartInputOf<K, 'query'>>
          ? K
          : never
        : never
      : never
    : never;
}[RouteId];

/** One item of a paged route's `items`. */
export type PageItemOf<K extends PagedRouteId> =
  ResponseOf<K> extends { items: readonly (infer I)[] } ? I : never;
