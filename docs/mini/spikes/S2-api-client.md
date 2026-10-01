# Spike S2: the storefront API client

**Question.** Can the mini program call `/api/v1` fully typed from `@shop/contracts` without shipping zod, the contracts or any admin path? Can it run on `Taro.request` as well as `fetch`, and use the same React Query conventions as the admin?

**Answer.** Yes. `packages/api-client` (`@shop/api-client`) does this.

- The client, its Taro transport and every storefront route come to **17.7 KB minified, 4.9 KB gzip** in an ES2017 bundle. The bundle contains no zod, no contract module, no `/admin-api` or `/staff/` path, and no `eval`/`new Function`.
- It passes against the `@shop/testing` mock server for every example of all 128 storefront routes.
- The hooks pass on both React 19 and React 18.3.1.

Usage is in `packages/api-client/README.md`. This document covers why the client is built this way, and what it found in the contracts.

## Design

```
@shop/contracts ──import type──▶ routes.gen.ts ◀── scripts/gen.ts (pnpm gen)
      │                             │ runtime: storefrontRouteList {id, method, path, auth}
      │                             │ types:   StorefrontContracts / RouteParts / DeclaredErrors
      │                             ▼
      │                       src/types.ts   InputOf<K>, ResponseOf<K>, ErrorCodeOf<K>, PagedRouteId
      │                             ▼
      │                       src/client.ts  createApiClient → client.call(id, input, options)
      │                             │  url.ts (path + query), errors.ts (ApiError), transport.ts
      │                             ▼
      │                       src/react.ts   provider + useRouteQuery / useInfiniteRouteQuery / useRouteMutation
      └──runtime import──▶ src/validate.ts  contractValidator(): the only file that loads zod
```

- **Types come from the contracts, the runtime from a generated table.**
  - The generator imports `@shop/contracts/routes` at _build_ time and keeps each storefront route's four request fields.
  - It also emits `import type { cartAddItem as cart_addItem } from '@shop/contracts/cart/cart.storefront.contract'` for the types.
  - TypeScript erases those imports, so the contracts never reach a bundle. The ESLint config enforces this too: `zod` and `@shop/contracts` may only be imported as types in `src/` (the tests and `validate.ts` excepted).
- **One `call`, not one function per route.**
  - `client.call('cart.addItem', { body })` keeps the output tree-shaking-neutral and the API small. The table costs about 11 KB whether an app uses 5 routes or all 128 (see the size table below).
  - Per-route functions would tree-shake, but they would need a second generator and would add call-site churn. The table alone is cheap enough.
- **The response type is `z.input<response>`, not `z.output`.**
  - `handle()` serialises what the handler returns (typed `z.input`) and only safe-parses it. So the JSON on the wire is the input shape.
  - For 127 of the 128 routes the two types are the same. The exception is noted below.
  - `src/types.test.ts` pins this down, so a new divergence fails a test.
- **The input is required only when it has to be.**
  - `InputOf<K>` makes `params`, `query` or `body` required only if that part has a required field.
  - A part the route does not declare is `?: undefined`, so passing one fails to compile.
  - The generator emits `StorefrontRouteParts`, because `defineRoute` types an omitted part as a bare `ZodType` and the client could not otherwise tell which parts are present.
- **Error codes are narrowed.**
  - `isApiError(e, 'cart.addItem')` narrows `e.code` to the union of:
    - the codes the route's contract declares (`StorefrontDeclaredErrors`);
    - `commonErrors`;
    - the five client codes;
    - `` `HTTP_${number}` ``.
  - A typo such as `'CART_TYPO'` fails to compile.
- **Transports are plain functions.** A transport has the type `(request) => Promise<{ status, headers, body: string }>`.
  - `taroTransport(Taro.request)` is typed structurally, with no `@tarojs` dependency. It was checked against the real Taro 4.2.1 `request` typings, including a negative control, in a scratch project.
  - Taro is asked for text and the client parses the JSON itself. Bad JSON is then an `ApiError` (`RESPONSE_PARSE_FAILED`) rather than a Taro exception, and 204 and empty bodies are handled in one place.
- **The mini-program runtime is respected.**
  - There is no `URL`, `URLSearchParams`, `AbortController`, `TextDecoder` or `Buffer` in `src/`. ESLint `no-restricted-globals` enforces this, and the bundle test checks the text.
  - The abort signal is structural (`AbortSignalLike`).
  - The query serialiser is hand-written. Its output round-trips through a verbatim copy of `handle()`'s `searchParamsToObject`, and a test fails if that copy drifts from `apps/web/src/server/handle.ts`.
- **401 handling.**
  - `onUnauthorized` runs once per burst: a 401 skips the handler when its request was sent before the last time the handler ran.
  - So four parallel calls with an expired token trigger one login redirect, and a 401 after re-login triggers another.
- **React.** It mirrors `apps/web/src/admin/api/hooks.ts`:
  - query keys are `[routeId, input]`, with the input normalised (keys sorted, `undefined` dropped);
  - infinite reads use `[routeId, input, 'infinite']`;
  - `invalidateRoutes(qc, ...ids)` prefix-matches `[routeId]`.
  - `useInfiniteRouteQuery` accepts only routes whose response is `{items,total,page,pageSize}` and whose query has `page`. This is checked by type (`PagedRouteId`).
  - Only React 18 APIs are used (`createContext`, `useContext`, `useCallback`, `createElement`).

## The generated table

`pnpm gen` runs `packages/api-client/scripts/gen.ts` and writes `src/routes.gen.ts`. The file is about 41 KB of source, and gitignored via `*.gen.ts`.

- **Selection:**
  - `path` starts with `/api/v1/`;
  - `path` does not start with `/api/v1/staff/`;
  - `auth` is one of `public`, `user`, `user-optional`.
- **Result:** 128 routes from 25 contract files. 40 staff and webhook routes are left out. Routes are sorted by id, so the diff is stable.

```ts
import type { cartAddItem as cart_addItem /* … */ } from '@shop/contracts/cart/cart.storefront.contract';

export const storefrontRouteList = [
  { id: 'cart.addItem', method: 'POST', path: '/api/v1/cart/items', auth: 'user' },
  /* …128 rows… */
] as const;

export interface StorefrontContracts { 'cart.addItem': typeof cart_addItem; /* … */ }
export interface StorefrontRouteParts { 'cart.addItem': 'body'; 'cart.count': never; /* … */ }
export interface StorefrontDeclaredErrors { 'cart.addItem': 'CART_OUT_OF_STOCK' | /* … */; }
```

The table is the whole runtime cost of the contracts: 10,956 B minified and 1,840 B gzip. An encoding as `[id, method, path, authIndex]` tuples would save about 4 KB minified and a few hundred bytes gzip. This was not worth the unreadable output, but it is an option if the main package ever gets close to its limit.

## Bundle numbers

These come from `src/bundle.test.ts`: esbuild, minified, `target: es2017`, ESM, platform `neutral`, with the package resolved by its own name. Run it with `pnpm --filter @shop/api-client exec vitest run src/bundle.test.ts --reporter=verbose` to print them.

| Bundle                                            | Minified | Gzip     | Input files |
| ------------------------------------------------- | -------- | -------- | ----------- |
| Sample consumer: client, Taro transport, 5 routes | 17.6 KB  | 4.8 KB   | 7           |
| Main entry, every export                          | 17.7 KB  | 4.9 KB   | 7           |
| `react` entry (react, TanStack external)          | 2.4 KB   | 1.1 KB   | 3           |
| `validate` entry (control)                        | 865.4 KB | 173.0 KB | 219         |

The client code alone, without the table, is about 6.5 KB minified.

Every bundle except the control is asserted to contain none of the following:

- by input file: zod, `packages/contracts/`, `validate.ts`, `@tarojs`;
- by output text: `_zod`/`ZodError`/`$ZodType`, `/admin-api`, `/staff/`, `new Function(`, `eval(`, `Object.fromEntries`, `.flatMap(`, `.replaceAll(`, `structuredClone`, `Promise.allSettled`, `URLSearchParams`, `new URL(`.

The control proves the checks can see these things: it must contain zod, the contracts and `/admin-api`.

`validate` pulls in every contract (admin included) through `@shop/contracts/routes`. It is for tests and dev builds only.

## Tests

`pnpm --filter @shop/api-client test:unit` runs 278 tests in two Vitest projects.

- **`url.test.ts`:**
  - path params;
  - query serialisation;
  - a round trip through `handle()`'s parser;
  - the drift check on that parser copy.
- **`client.test.ts`:**
  - URL, body and headers;
  - the `public` / `user` / `user-optional` token rules;
  - header precedence;
  - 204 and empty bodies;
  - the error mapping: JSON errors, non-JSON errors (`HTTP_502`), 422 field errors, network failures, aborts;
  - 401 → `onUnauthorized` exactly once for a burst of four, again later, never for 403;
  - `taroTransport`: the exact option object, header casing, PATCH refused and allowed, abort, `fail`;
  - `fetchTransport`.
- **`types.test.ts`:** compile-time assertions:
  - required and optional input;
  - an undeclared part rejected;
  - response types;
  - error-code narrowing;
  - `PagedRouteId`;
  - `z.input` equal to `z.output` for every route but one.
- **`contract.test.ts`:** the client against `startMockServer()`, with `contractValidator()` on.
  - The required routes: catalog list and detail, cart add, checkout preview, order create, payment start, coupon list (`coupon.claimableList`), groupbuy detail, DIY home, site config, profile.
  - It also covers a 204, a typed 422 with field errors, a lying response rejected by the validator, and a sweep over **every example of every storefront route**.
- **`bundle.test.ts`:** the numbers and assertions above.
- **`react.test.ts`:**
  - query keys;
  - `useRouteQuery` success and error;
  - `useInfiniteRouteQuery` over three pages (exact URLs, `flattenPages`, stop at `total`);
  - `useRouteMutation` invalidating `cart.count`;
  - `invalidateRoutes` refreshing plain and infinite reads of `order.list`.
  - It runs in the `unit` project on React 19 and again in `unit-react18` on React 18.3.1.

## Limitations and deviations from the brief

- **The response type is `z.input`, not `z.output`.** The wire carries `z.input` (see Design).
- **Staff routes are excluded by path, not only by auth.** `order.staffMe` has `user` auth but lives at `/api/v1/staff/me`. It is excluded, so the bundle can promise "no `/staff/`". If the storefront needs it (a "staff entrance" on 我的), it should move, or the rule should be relaxed. See open questions.
- **PATCH is refused on Taro by default.** `wx.request` has no PATCH. Only `cart.updateItem` uses it; see the contract findings.
- **No `@testing-library/react`.** It loads `react-dom` through a CommonJS `require` that the React 18 project's alias cannot redirect, so a small `test-support/render-hook.ts` (`createRoot` + `act`, and a `waitFor` that suspends the act environment while it polls, as Testing Library's does) is used instead.
- **How the React 18 run works.**
  - It uses `react-18`/`react-dom-18` npm aliases (dev dependencies) plus Vite aliases, with TanStack Query inlined.
  - pnpm satisfied `react-dom@18`'s `react` peer with React 19, so `test-support/react18-setup.ts` redirects that one CommonJS `require` inside the project.
  - This is test-only plumbing. `apps/mini` will run its own tests on its own React 18.
- **`validate` is all or nothing.** It loads `@shop/contracts/routes`, meaning every contract, admin included. A per-domain validate entry is possible if dev builds ever need it smaller.
- **The query type follows zod's input type**, so `page` is `unknown` (see below). The client serialises what it is given; the server parses it.
- **The `X-Client-Version` header is sent but not read.** See below.
- **The guards do not look at this package.** `guards/src/checks/banned.ts` and `retired.ts` scan only `apps/web`, `apps/worker`, `packages/core` and `packages/contracts`. `pnpm guards` passes, but it says nothing about `packages/api-client`. Its own ESLint rules and the bundle test do that job.
- **Turbo caching.** The drift check reads `apps/web/src/server/handle.ts`, which is not an input of `@shop/api-client#test:unit`. A cached pass can therefore miss a change to `handle.ts` until something in the package changes. It is harmless in CI (the cache is cold), but it is worth an `inputs` entry if it ever bites.

## Contract typing problems for the backend stream

Ordered by how much they affect the storefront.

1. **`cart.updateItem` is PATCH** (`cart/cart.storefront.contract.ts:121`). `wx.request` (and so `Taro.request` on WeChat) supports only OPTIONS, GET, HEAD, POST, PUT, DELETE, TRACE and CONNECT. Suggestion: make it PUT (it sets the quantity, so it is idempotent), or add a POST alias.
2. **`order.staffMe` is under `/api/v1/staff/`** with `user` auth (`order/order.staff.contract.ts:61`). It is the only non-staff-auth route on a staff path. Either it is a staff route (then change its auth), or it belongs under `/api/v1/me/…`.
3. **`pageQuery` uses `z.coerce.number()`** (`_conventions/common.ts:33`). Its input type is `unknown`, so every paged route accepts `page: 'abc'` and `page: {}` at compile time. Suggestion: `z.union([z.number(), z.string()]).pipe(z.coerce.number()…)`. Then the input type is `number | string` and the server behaviour stays the same. The same applies to every other `z.coerce` in a query.
4. **`z.stringbool()` in queries** (for example `notification/schemas.ts:283` `unreadOnly`). The input type is `string`, so the client must write `unreadOnly: 'true'`. A `boolean | 'true' | 'false'` input, preprocessed on the server, would read naturally at the call site. This has no effect at run time: the client already serialises booleans as `'true'`/`'false'`.
5. **`order.checkoutPreview` input and output differ.** `customFormFields: z…default([])` (`order/schemas.ts:213`) makes the field optional on the wire but required in `z.output`. The client types the field as `?` (correct for the wire). A consumer reading `z.infer` would be wrong. Either drop the default and always send the field, or keep the default and accept it. `types.test.ts` fails if a second route diverges.
6. **Open records where the storefront needs a shape.** `kindMeta: z.record(z.string(), z.unknown())` (`order/schemas.ts:85`) is documented in prose only: `{ activityId, groupId? }` for groupbuy, `{ activityId }` for presale. A discriminated union by order kind would type the groupbuy and presale checkout. Other `z.record(…, z.unknown())` and `z.unknown()` fields sit in `diy/schemas.ts`, `diy/schema/primitives.ts`, `notification/schemas.ts`, `payment/schemas.ts` and `system/schemas.ts`. The DIY ones are expected (block props are the S3 stream's business). The payment ones (`payment.start`'s client payload) will decide how much the mini program's `requestPayment` call is typed.
7. **`errorRegistry` is `Record<string, ErrorSpec>`** (`errors.gen.ts:43`), so the full set of codes is not a type. The client narrows by each route's declared `errors` plus `commonErrors`. If a handler throws a code its contract does not list, the code still arrives, but typed as a string outside the union. Suggestion: emit `as const` (or a `ErrorCode` union) from the errors generator, and a guard that every code a handler throws is declared on its route.
8. **`X-Client-Version` is not read by the server.** `handle()` reads `X-Client-Platform` only (`apps/web/src/server/handle.ts:207`). The client sends the version anyway, since the brief asked for it. It is useful for logs and for a future "please update" 426.
9. **A single-element query array arrives as a scalar.** `handle()`'s `searchParamsToObject` gives an array only for a repeated key. An array-typed query field must accept a lone string (`idList` does). A new array query without that preprocessing will reject `?ids=1`.
10. **The mock server drops repeated query keys.** `@shop/testing/mock-server` builds the query with `Object.fromEntries`, so `?ids=1&ids=2` validates as `ids: '2'`. It should share `handle()`'s `searchParamsToObject`.
11. **The admin's `parseFieldErrors` misses `handle()`'s 422 shape.** This is outside the storefront, found in passing. `apps/web/src/admin/api/errors.ts:74-88` reads `[{ path: [...], message }]`, but `handle()` sends `[{ field: 'body.x', message }]` (`handle.ts:125-131`). So admin forms may not map server 422s onto fields. `@shop/api-client`'s `parseFieldErrors` reads both.

## Open questions

- Should `order.staffMe` be reachable from the storefront client (see finding 2)?
- `taroTransport` refuses PATCH on every platform by default. Should `apps/mini` enable it on H5 builds (`unsupportedMethods: []`), or should the contract change (finding 1) so no platform needs it?
- Should `@shop/api-client` join the guards' scan list (`banned.ts`), or are its ESLint rules and bundle test enough?
- Token storage and refresh are out of scope here. `getToken` and `onUnauthorized` are the hooks; the auth flow belongs to `apps/mini`.
