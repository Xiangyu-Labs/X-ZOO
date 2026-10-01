import { errorBody, type AnyRouteDef, type ErrorBody, type ResponseOf } from '@shop/contracts';
import { errorRegistry } from '@shop/contracts/errors';
import type { z } from 'zod';

import { configureApi } from '@/admin/api/config';

/**
 * The one way a component test answers a request.
 *
 * A stubbed `fetch` hands back a hand-written object, and the component under
 * test believes it: nothing on the client compares it to the contract (the
 * server does, under `VALIDATE_RESPONSES`, but a component test has no
 * server). A fixture that misses a required field then passes until some
 * component reads that field — which may depend on timing, on the open tab, or
 * on whether a drawer got far enough to render — and a stale fixture reads as a
 * flaky test instead of as a fixture that disagrees with its contract.
 *
 * So every fixture goes through the route it claims to answer:
 *
 *   - `respondWith(route, value)` parses `value` with `route.response` and fails
 *     the test, with zod's path, when it does not match — or when it carries a
 *     key the contract does not declare, which is how a dropped field lingers;
 *   - `respondWithError(status, body)` does the same for the error envelope;
 *   - `stubRoutes([...])` wires a set of `on(route, reply)` answers into the
 *     client, matching on method and path, and records every call — and parses
 *     each request the way the server would (path params with `route.params`,
 *     the query string with `route.query`, a JSON body with `route.body`), so a
 *     page that sends what the contract refuses — a picker asking for
 *     `pageSize: 200` against a cap of 100 — fails its test instead of passing
 *     until the server answers 400/422 in production;
 *   - an error a stub answers must be one the route can give: a code the route
 *     declares in `errors` (or one any route may return), with the status the
 *     code is registered under. A test of a failure the server never sends
 *     proves nothing.
 *
 * `pnpm guards fixtures` keeps this the only way: a test that stubs `fetch`
 * does not build a `Response` by hand.
 */

// ---------------------------------------------------------------------------
// Fixture failures
// ---------------------------------------------------------------------------

/**
 * A stub runs inside `callRoute`'s `fetch`, and `callRoute` turns anything the
 * transport throws into a "network" `ApiError` — so a throw alone would be
 * rendered as 网络连接失败 and might never fail the test. Each failure is also
 * recorded here, and `setup.ts` fails the test that produced it.
 */
const fixtureFailures: string[] = [];

/** Drains the failures recorded since the last call. Used by `setup.ts`. */
export function takeFixtureFailures(): string[] {
  return fixtureFailures.splice(0, fixtureFailures.length);
}

function fixtureError(message: string): Error {
  fixtureFailures.push(message);
  return new Error(message);
}

function describeIssues(issues: z.ZodError['issues']): string {
  return issues
    .map(
      (issue) => `  - ${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
    )
    .join('\n');
}

/**
 * Keys present in `sent` but absent from what the schema kept. zod strips an
 * undeclared key without complaint, so without this a fixture could keep
 * serving a field the contract dropped long ago.
 */
function strayKeys(sent: unknown, kept: unknown, at: string[] = []): string[] {
  if (Array.isArray(sent) && Array.isArray(kept)) {
    return sent.flatMap((item, index) => strayKeys(item, kept[index], [...at, String(index)]));
  }
  if (!isPlainObject(sent) || !isPlainObject(kept)) return [];
  return Object.keys(sent).flatMap((key) =>
    key in kept ? strayKeys(sent[key], kept[key], [...at, key]) : [[...at, key].join('.')],
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The request side of `checkFixture`: what the component sent, parsed as the
 * server parses it. A key the contract does not declare fails too — the server
 * drops it without a word, so a form that still sends a retired field would
 * otherwise go on "saving" it forever.
 */
function checkRequestBody(schema: z.ZodType, value: unknown, what: string): string | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return `request body for ${what} does not match its contract:\n${describeIssues(parsed.error.issues)}`;
  }
  const stray = strayKeys(value, parsed.data);
  if (stray.length > 0) {
    return `request body for ${what} carries keys its contract does not declare:\n${stray.map((key) => `  - ${key}`).join('\n')}`;
  }
  return null;
}

/** The request's query string as the server hands it to `route.query` (see `handle()`). */
function queryObject(query: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set(query.keys())) {
    const values = query.getAll(key);
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}

function checkRequestPart(schema: z.ZodType, value: unknown, what: string): string | null {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? null
    : `${what} does not match its contract:\n${describeIssues(parsed.error.issues)}`;
}

/**
 * Codes `handle()` itself may answer on any route, whatever the route lists:
 * the common ones, plus the session and CSRF refusals of an admin route.
 */
const ALWAYS_POSSIBLE = new Set([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'INTERNAL',
  'AUTH_SESSION_EXPIRED',
  'AUTH_TOKEN_INVALID',
  'AUTH_CROSS_SITE_BLOCKED',
]);

/**
 * An error the stub answers, compared with what the route can answer: the code
 * must be declared on the route (or be one any route may give), and its status
 * the one the code is registered with. `null` when it is fine.
 */
export function checkErrorReply(route: AnyRouteDef, status: number, body: unknown): string | null {
  const parsed = errorBody.safeParse(body);
  if (!parsed.success) return `error answered for ${route.id} is not an error envelope`;
  const { code } = parsed.data;
  if (!ALWAYS_POSSIBLE.has(code) && !(route.errors ?? []).includes(code)) {
    return `${route.id} does not declare ${code} in its errors; the server never answers it there`;
  }
  const registered = errorRegistry[code];
  if (registered !== undefined && registered.status !== status) {
    return `${code} is a ${registered.status}, but the stub for ${route.id} answered ${status}`;
  }
  return null;
}

function checkFixture(schema: z.ZodType, value: unknown, what: string): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw fixtureError(
      `fixture for ${what} does not match its contract:\n${describeIssues(parsed.error.issues)}`,
    );
  }
  const stray = strayKeys(value, parsed.data);
  if (stray.length > 0) {
    throw fixtureError(
      `fixture for ${what} carries keys its contract does not declare:\n${stray.map((key) => `  - ${key}`).join('\n')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Answers `route` with `value`, after checking that `value` is what the
 * contract says the route returns. The body sent is `value` itself, exactly as
 * a handler's result goes on the wire. A `204` route answers with no body.
 */
export function respondWith<R extends AnyRouteDef>(route: R, value: ResponseOf<R>): Response {
  const status = route.status ?? 200;
  if (status === 204) return new Response(null, { status });
  checkFixture(route.response, value, route.id);
  return jsonResponse(status, value);
}

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503;

/** Answers with the error envelope every non-2xx response carries. */
export function respondWithError(status: ErrorStatus, body: ErrorBody): Response {
  checkFixture(errorBody, body, `a ${status} error`);
  return jsonResponse(status, body);
}

// ---------------------------------------------------------------------------
// A stubbed API
// ---------------------------------------------------------------------------

/** One request the component made, as the stub saw it. */
export interface StubCall {
  method: string;
  /** The full URL as the client built it, query string included. */
  url: string;
  /** The path, without the query string. */
  path: string;
  query: URLSearchParams;
  /** The parsed JSON body, or `undefined` when there was none (or it was `FormData`). */
  body: unknown;
  /** Path parameters, by the names the route's path declares. */
  params: Record<string, string>;
  /** The id of the route that answered, or `null` when nothing matched. */
  routeId: string | null;
}

/** What a stubbed route answers: a fixture, or a finished `Response` (an error, a delay). */
type Reply<R extends AnyRouteDef> =
  | ResponseOf<R>
  | ((call: StubCall) => ResponseOf<R> | Response | Promise<ResponseOf<R> | Response>);

export interface RouteStub {
  route: AnyRouteDef;
  matches(method: string, path: string): Record<string, string> | null;
  answer(call: StubCall): Promise<Response>;
}

function pathPattern(path: string): { re: RegExp; names: string[] } {
  const names: string[] = [];
  const source = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        names.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { re: new RegExp(`^${source}$`), names };
}

/**
 * Declares how the stub answers `route`. `reply` is either the fixture itself
 * or a function of the call, which may return a finished `Response` —
 * `respondWithError(…)` for a failure path, or a promise to hold the answer.
 */
export function on<R extends AnyRouteDef>(route: R, reply: Reply<R>): RouteStub {
  const { re, names } = pathPattern(route.path);
  return {
    route,
    matches(method, path) {
      if (method !== route.method) return null;
      const match = re.exec(path);
      if (!match) return null;
      return Object.fromEntries(
        names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? '')]),
      );
    },
    async answer(call) {
      const value =
        typeof reply === 'function'
          ? await (
              reply as (
                call: StubCall,
              ) => ResponseOf<R> | Response | Promise<ResponseOf<R> | Response>
            )(call)
          : reply;
      return value instanceof Response ? value : respondWith(route, value as ResponseOf<R>);
    },
  };
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
}

/**
 * Points the admin client at `stubs` and returns the log of calls it makes.
 *
 * Each request is answered by the first stub whose route has the same method
 * and whose path pattern matches. A request nothing answers is a test bug: it
 * is recorded as a fixture failure (so the test fails, naming the request) and
 * answered with a 502 so the component sees an ordinary error meanwhile.
 * `resetApiConfig()` undoes this.
 */
export function stubRoutes(stubs: readonly RouteStub[]): StubCall[] {
  const calls: StubCall[] = [];
  // A named function rather than a method called fetch: this implements
  // fetch, and `pnpm guards banned` would read the method as a raw call.
  async function answer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = urlOf(input);
    // Not `new URL(…)`: a test may stub the global `URL` (to catch
    // `createObjectURL`), and the stub must keep routing when it does.
    const queryAt = url.indexOf('?');
    const path = (queryAt === -1 ? url : url.slice(0, queryAt)).replace(/^[a-z]+:\/\/[^/]+/i, '');
    const query = new URLSearchParams(queryAt === -1 ? '' : url.slice(queryAt + 1));
    const method = (init?.method ?? 'GET').toUpperCase();
    let stub: RouteStub | undefined;
    let params: Record<string, string> = {};
    for (const candidate of stubs) {
      const matched = candidate.matches(method, path);
      if (matched) {
        stub = candidate;
        params = matched;
        break;
      }
    }
    const call: StubCall = {
      method,
      url,
      path,
      query,
      body: bodyOf(init),
      params,
      routeId: stub?.route.id ?? null,
    };
    calls.push(call);
    if (!stub) {
      fixtureFailures.push(`no stub answers ${method} ${url}`);
      return respondWithError(502, {
        code: 'TEST_UNSTUBBED',
        message: `no stub answers ${method} ${path}`,
      });
    }
    const route = stub.route;
    const paramsSchema = route.params as z.ZodType | undefined;
    const querySchema = route.query as z.ZodType | undefined;
    const bodySchema = route.body as z.ZodType | undefined;
    const failure =
      (paramsSchema === undefined
        ? null
        : checkRequestPart(paramsSchema, params, `path params for ${route.id}`)) ??
      (querySchema === undefined
        ? null
        : checkRequestPart(querySchema, queryObject(query), `query for ${route.id}`)) ??
      // A multipart upload is not JSON and its schema is the server's to apply
      // to the parts; every other body is checked as the server would check it.
      (bodySchema === undefined || init?.body instanceof FormData
        ? null
        : checkRequestBody(bodySchema, call.body, route.id));
    if (failure !== null) {
      fixtureFailures.push(failure);
      // What the server would say, so the component is not led further on.
      return respondWithError(422, { code: 'VALIDATION_FAILED', message: failure });
    }
    const response = await stub.answer(call);
    if (response.status >= 400) {
      const text = await response.clone().text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
      const problem = checkErrorReply(route, response.status, parsed);
      if (problem !== null) fixtureFailures.push(problem);
    }
    return response;
  }
  configureApi({ fetch: answer });
  return calls;
}
