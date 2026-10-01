import { storefrontRouteList } from '@shop/api-client';
import { contractOf, errorReplyProblem } from '@shop/api-client/validate';
import type { AnyRouteDef } from '@shop/contracts/conventions';
import { taroFake } from './taro-fake/taro';

export interface FakeReply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface SeenRequest {
  key: string;
  /** The query string, decoded (a repeated key's values joined by commas). */
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

/** Answers one stubbed route: the request's JSON body, and the whole request (query, headers). */
export type FakeHandler = (body: unknown, request: SeenRequest) => FakeReply;

type RouteMeta = (typeof storefrontRouteList)[number];

const ROUTES = storefrontRouteList.map((meta) => ({
  meta,
  names: meta.path
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1)),
  re: new RegExp(
    `^${meta.path
      .split('/')
      .map((segment) =>
        segment.startsWith(':') ? '([^/]+)' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join('/')}$`,
  ),
}));

// A literal segment wins over a `:param` (`/orders/counts` before `/orders/:id`).
ROUTES.sort((a, b) => a.meta.path.split(':').length - b.meta.path.split(':').length);

function match(
  method: string,
  path: string,
): { meta: RouteMeta; params: Record<string, string> } | null {
  for (const route of ROUTES) {
    if (route.meta.method !== method) continue;
    const found = route.re.exec(path);
    if (!found) continue;
    const params: Record<string, string> = {};
    route.names.forEach((name, index) => {
      params[name] = decodeURIComponent(found[index + 1] ?? '');
    });
    return { meta: route.meta, params };
  }
  return null;
}

/**
 * Where a stub, a request and the contract disagree, collected while a test runs and failed
 * after it (src/test/setup.ts): a throw inside the transport would only reach the page as a
 * network error. A stub the server could never send — a 204 for a route that answers
 * `{ ok: true }`, a success for a body it would refuse, an error code the route never gives —
 * lets a test pass on a page that breaks against the real server (78a56cfe2; AGENTS.md 20).
 */
export const contractMismatches: string[] = [];

const describeIssues = (issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>) =>
  issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join('.')} ${issue.message}`)
    .join('; ');

/** The query as the server hands it to the route's schema: one value a string, several an array. */
function queryObject(search: string): Record<string, string | string[]> {
  const query = new URLSearchParams(search);
  const out: Record<string, string | string[]> = {};
  for (const name of new Set(query.keys())) {
    const values = query.getAll(name);
    out[name] = values.length > 1 ? values : (values[0] ?? '');
  }
  return out;
}

/** What the page sent, parsed as the server would: path params, query and JSON body. */
function checkRequest(
  key: string,
  id: string,
  params: Record<string, string>,
  search: string,
  body: unknown,
) {
  const route = contractOf(id);
  const parts: Array<[string, AnyRouteDef['query'], unknown]> = [
    ['path params', route.params, params],
    ['query', route.query, queryObject(search)],
    ['body', route.body, body],
  ];
  for (const [part, schema, value] of parts) {
    if (!schema || (part === 'body' && value === undefined)) continue;
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      contractMismatches.push(
        `${key}: the page sent ${part} ${id} refuses: ${describeIssues(parsed.error.issues)}`,
      );
    }
  }
}

/** What the reverse proxy answers by itself when the app is down or slow. */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

const isEnvelope = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && 'code' in body && 'message' in body;

/** What the stub answered, against what the route can answer. */
function checkReply(key: string, id: string, reply: FakeReply) {
  const route = contractOf(id);
  const status = reply.status ?? 200;
  // A conditional GET's answer (If-None-Match): no body, nothing to check.
  if (status === 304 && route.method === 'GET') return;
  // The edge's own page (nginx during a deploy), not our handler: no envelope to check.
  if (GATEWAY_STATUSES.has(status) && !isEnvelope(reply.body)) return;
  if (status < 200 || status >= 300) {
    const problem = errorReplyProblem(id, status, reply.body);
    if (problem) contractMismatches.push(`${key}: ${problem}`);
    return;
  }
  const expected = route.status ?? 200;
  if (status !== expected) {
    contractMismatches.push(`${key}: the stub answers ${status}, ${id} answers ${expected}`);
    return;
  }
  if (expected === 204) return;
  const parsed = route.response.safeParse(reply.body);
  if (!parsed.success) {
    contractMismatches.push(
      `${key}: the stub's body is not a ${id} response: ${describeIssues(parsed.error.issues)}`,
    );
  }
}

/**
 * Answers `Taro.request` (the weapp transport the tests run on) from a table keyed by
 * `"METHOD /path"` (no query string). It is the one way a mini test answers a request
 * (lint refuses `taroFake.onRequest = …` elsewhere), and it holds every exchange to the
 * contracts, as the server would:
 *
 * - a key that names no storefront route throws at once: the page could never be answered by it;
 * - a request to a path no storefront route has, or with path params, a query or a body its
 *   route refuses, fails the test (`contractMismatches`);
 * - a stubbed answer must be what the route gives: its success status and response schema, or
 *   an error envelope with a code the route declares (or any route may give) at that code's
 *   status. Two answers come from elsewhere and pass as they are: a 304 to a GET, and a
 *   502/503/504 that is not an envelope (the proxy's own page, as during a deploy);
 * - a request nothing stubs fails the test, naming it; the page meanwhile gets a 404
 *   `NOT_FOUND`, so it is not led further on. A test of a missing record stubs the 404 itself.
 *
 * Returns what was asked, in order.
 */
export function serveApi(routes: Record<string, FakeHandler>): SeenRequest[] {
  for (const key of Object.keys(routes)) {
    const [method = '', path = ''] = key.split(' ');
    if (!match(method, path)) {
      throw new Error(`serveApi: "${key}" is no storefront route; the page can never call it`);
    }
  }
  const seen: SeenRequest[] = [];
  taroFake.onRequest = (option) => {
    const [path = '', search = ''] = option.url.replace(/^https?:\/\/[^/]+/, '').split('?');
    const query: Record<string, string> = {};
    for (const [name, value] of Object.entries(queryObject(search)))
      query[name] = typeof value === 'string' ? value : value.join(',');
    const key = `${option.method} ${path}`;
    const body: unknown = option.data === undefined ? undefined : JSON.parse(option.data);
    const request: SeenRequest = { key, query, headers: option.header, body };
    seen.push(request);
    const route = match(option.method, path);
    if (!route) {
      contractMismatches.push(`${key}: the page called a path no storefront route has`);
    } else {
      checkRequest(key, route.meta.id, route.params, search, body);
    }
    const handler = routes[key];
    const reply = handler
      ? handler(body, request)
      : { status: 404, body: { code: 'NOT_FOUND', message: `no fake for ${key}` } };
    if (handler && route) checkReply(key, route.meta.id, reply);
    if (!handler && route) contractMismatches.push(`${key}: no stub answers it (serveApi)`);
    return {
      statusCode: reply.status ?? 200,
      data: JSON.stringify(reply.body),
      ...(reply.headers ? { header: reply.headers } : {}),
    };
  };
  return seen;
}

/**
 * Holds every answer to a path ending in `path` (after `serveApi`) until `release()`: what went
 * out while it was pending shows which requests ran side by side.
 */
export function holdRequests(path: string): { release: () => void } {
  const answer = taroFake.onRequest;
  const waiting: Array<() => void> = [];
  taroFake.onRequest = (option) =>
    option.url.split('?')[0]?.endsWith(path)
      ? new Promise((resolve) => waiting.push(() => resolve(answer(option))))
      : answer(option);
  return { release: () => waiting.splice(0).forEach((go) => go()) };
}
