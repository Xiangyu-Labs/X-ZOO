# @shop/api-client

The storefront's typed client for `/api/v1`. It is typed from `@shop/contracts` and carries no zod at run time.
It works with any transport: `fetch` (H5, tests, Node) or `Taro.request` (mini programs).

```ts
import Taro from '@tarojs/taro';
import { createApiClient, isApiError, taroTransport } from '@shop/api-client';

const client = createApiClient({
  baseUrl: 'https://shop.example',
  transport: taroTransport(Taro.request),
  platform: 'wechat-mini', // sent as X-Client-Platform
  clientVersion: '1.4.0', // sent as X-Client-Version
  getToken: () => Taro.getStorageSync('token') || null, // sync or async
  onUnauthorized: () => Taro.navigateTo({ url: '/pages/login/index' }),
});

const product = await client.call('catalog.productDetail', { params: { id } });
const page = await client.call('catalog.productList', { query: { keyword: '茶', page: 2 } });
await client.call('cart.addItem', { body: { skuId, quantity: 1 } });
const count = await client.call('cart.count'); // no input needed, none asked for
```

## Entries

| Entry                       | What it is                                                                                      | Runtime deps                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `@shop/api-client`          | `createApiClient`, `ApiError`, `fetchTransport`, `taroTransport`, the route table, types        | none                                                   |
| `@shop/api-client/react`    | `ApiClientProvider`, `useRouteQuery`, `useInfiniteRouteQuery`, `useRouteMutation`, invalidation | peers `react` ^18 \|\| ^19, `@tanstack/react-query` ^5 |
| `@shop/api-client/validate` | `contractValidator()`, `contractOf(id)`: response checks against the full contracts             | zod + every contract (about 865 KB)                    |
| `@shop/api-client/routes`   | `storefrontRoutes`, the page catalogue (route key -> mini-program page), and its types          | none                                                   |

The main entry and `react` never import `validate`; the main entry re-exports the page catalogue too. `src/bundle.test.ts` checks this and fails if zod, a contract module, an admin or staff path, `eval`/`new Function`, or `URL`/`URLSearchParams` gets into a minified ES2017 bundle.
Use `validate` in tests, dev builds and the mock-server run, not in a shipped mini program.

## What a call does

`client.call(routeId, { params, query, body }, { signal, headers })`:

- **Types.** The route id is checked, and so are its params, query, body and response.
  - The input is required only when the route has a required field.
  - A part the route does not declare is typed `undefined`.
  - The response is the contract's `z.input` of `response`, which is exactly what `handle()` puts on the wire.
- **URL.**
  - `:param`s are substituted and URI-encoded. A missing param throws before any request is made.
  - The query is serialised the way `handle()` reads it back:
    - keys are sorted, and an array becomes a repeated key;
    - `undefined`, `null` and `''` are dropped;
    - booleans become `true`/`false` and Dates become ISO strings.
- **Headers.**
  - `Authorization: Bearer <token>` is sent on `user` and `user-optional` routes when `getToken()` returns one. It is never sent on `public` routes.
  - Every call also sends `X-Client-Platform`, `X-Client-Version` and `Accept: application/json`.
  - `Content-Type: application/json` is sent whenever there is a body.
- **Response.**
  - A 2xx resolves to the parsed JSON body. A 204, or any empty body, resolves to `undefined`.
- **Errors.** Every failure rejects with an `ApiError`:

| Field     | Meaning                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| `status`  | HTTP status; `0` when there was no response                                              |
| `code`    | the server's code, or a client code (see below), or `HTTP_<status>` for a non-JSON error |
| `message` | the server's message (Chinese), or a Chinese fallback per status                         |
| `details` | the server's details (for a 422, `[{ field, message }]`)                                 |
| `routeId` | the route that failed                                                                    |

- Client codes: `NETWORK_ERROR`, `REQUEST_ABORTED`, `RESPONSE_PARSE_FAILED`, `RESPONSE_SCHEMA_MISMATCH` (from `validate`), and `METHOD_UNSUPPORTED`.
- `error.fieldErrors` reads a 422's details as `{ 'items.0.skuId': '…' }`.
- `isApiError(e, 'cart.addItem')` narrows `e.code` to what that route can answer: the codes its contract declares, the common codes, the client codes, and `HTTP_${number}`.
- **401.** `onUnauthorized` runs once for a burst of parallel 401s: requests sent before the handler ran do not trigger it again. A later 401 triggers it again.

## React

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ApiClientProvider,
  flattenPages,
  useInfiniteRouteQuery,
  useRouteMutation,
  useRouteQuery,
} from '@shop/api-client/react';

<QueryClientProvider client={queryClient}>
  <ApiClientProvider client={client}>{app}</ApiClientProvider>
</QueryClientProvider>;

const detail = useRouteQuery('catalog.productDetail', { params: { id } });
const list = useInfiniteRouteQuery('catalog.productList', { query: { keyword } });
const products = flattenPages(list.data); // every page's items, in order
const add = useRouteMutation('cart.addItem', { invalidate: ['cart.list', 'cart.count'] });
add.mutate({ body: { skuId, quantity: 1 } });
```

- **Query keys** are `[routeId, input]`. The input is normalised, so key order does not matter and `undefined` values are dropped. Page-by-page reads use `[routeId, input, 'infinite']`.
  - `routeQueryKey(id, input)` builds the key.
  - `routeQueryOptions(client, id, input)` works for `prefetchQuery`, `ensureQueryData` and `useSuspenseQuery`.
- **Invalidation.** `invalidateRoutes(queryClient, ...ids)` (or `useInvalidateRoutes()`) prefix-matches `[routeId]`. It refreshes every read of those routes, whatever their input, plain and infinite alike.
  - To refresh a single read, invalidate its full `routeQueryKey`.
  - `useRouteMutation({ invalidate })` does this on success, before your own `onSuccess` runs.
- **`useInfiniteRouteQuery`** accepts only routes that are GET, take `page` in their query, and answer `{ items, total, page, pageSize }`.
  - It starts at page 1.
  - It stops on an empty page, or when `page * pageSize >= total`.

These are the same conventions as the admin's hooks in `apps/web/src/admin/api`.

## Transports

A transport is `(request: { url, method, headers, body, signal, timeoutMs }) => Promise<{ status, headers, body: string }>`.

- `fetchTransport(fetch?)` uses the global `fetch` at call time. You can also pass your own.
- `taroTransport(Taro.request, { unsupportedMethods })`:
  - It asks Taro for text and parses the body itself, so a bad body becomes an `ApiError` instead of a Taro exception.
  - It lowercases header names and wires `signal` to `task.abort()`.
  - It has no `@tarojs` dependency: the parameter is typed structurally, and `Taro.request` fits it.
  - `wx.request` has no PATCH, so a PATCH route (today only `cart.updateItem`) is refused with `METHOD_UNSUPPORTED` by default. Pass `unsupportedMethods: []` where the platform has PATCH (H5).

## The route table

`pnpm gen` (the package's `gen` task, `scripts/gen.ts`) writes `src/routes.gen.ts`. The file is gitignored.

- It includes every route under `/api/v1` whose auth is `public`, `user` or `user-optional`.
- It holds a runtime `storefrontRouteList` of `{ id, method, path, auth }`.
- It also holds type-only maps from route id to the contract (`import type`), to the parts the route declares, and to its declared error codes.

If the file is missing, run `pnpm gen` from the repo root.

## The page catalogue

`storefrontRoutes` is not `storefrontRouteList`: the list above is the API's endpoints, the catalogue is the mini-program's pages. The catalogue itself (zod params, `toMiniPath`, `encodeScene`, `decodeScene`) lives in `@shop/contracts/system/storefront-routes`; see [docs/mini/pages.md](../../docs/mini/pages.md) §3. `scripts/gen-storefront-routes.ts` (part of `gen`) writes `src/storefront-routes.gen.ts` from it, also gitignored:

```ts
import { storefrontRoutes, type StorefrontRoute } from '@shop/api-client/routes';

storefrontRoutes.order; // { path: 'packages/order/detail/index', params: ['id', 'outTradeNo'], tab: false, share: 'none' }
```

- One entry per key: `path` (no leading `/`), `params` (the names the key takes; `order` lists both of its alternatives), `tab`, `share`.
- `StorefrontRouteKey`, `StorefrontRoute` and `StorefrontRouteParams<K>` come from the contracts through `import type`.
- Keys are append-only. A key this build does not know (a link saved by a newer backend) opens the home page.

## Scripts

`gen`, `typecheck`, `lint`, and `test:unit`. `test:unit` runs two projects:

- `unit` (React 19);
- `unit-react18`, which runs the hook tests again on React 18.3.1, the version Taro ships.

The mock-server contract test is part of `unit`: it starts a local server on port 0.
