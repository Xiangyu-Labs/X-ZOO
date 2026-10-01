import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { z } from 'zod';
import type { AnyRouteDef, RouteExample } from '@shop/contracts/conventions';
import { allRoutes } from '@shop/contracts/routes';
// The mock must produce the same 422 bodies the real handler does.
import '@shop/contracts/locale';

/**
 * The contract mock server.
 *
 * It lets a client be built against a contract before the handler behind it
 * exists. It knows nothing about the domain: it answers every registered route
 * with an example from the contract, and it validates whatever the client sent
 * against the contract's zod schemas — so a client developed against it cannot
 * drift from the real API.
 *
 *  - response: the route's **first** example, or the one named by the
 *    `X-Mock-Example` request header;
 *  - params / query / body that do not parse: `422 VALIDATION_FAILED` in
 *    exactly the shape `handle()` produces, field errors included;
 *  - unknown path: `404 NOT_FOUND`; known path, wrong method: `405`.
 *
 * It deliberately does **not** check auth. A mock that rejected an unauthenticated
 * call would force every client developer to build a login flow first, which is
 * the opposite of the point. `X-Mock-Example` covers the "what does a 403 look
 * like" case instead.
 */

export interface MockServerOptions {
  port?: number;
  host?: string;
  routes?: readonly AnyRouteDef[];
  /** Logged per request when true. */
  verbose?: boolean;
}

export interface RunningMockServer {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

interface CompiledRoute {
  route: AnyRouteDef;
  regex: RegExp;
  paramNames: string[];
}

export function compileRoute(route: AnyRouteDef): CompiledRoute {
  const paramNames: string[] = [];
  const pattern = route.path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return escapeRegex(segment);
      paramNames.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { route, regex: new RegExp(`^${pattern}$`), paramNames };
}

/**
 * A route's shape as a string of `0` (static segment) and `1` (`:param`).
 *
 * `/api/v1/addresses/default` is `0000` and `/api/v1/addresses/:id` is `0001`,
 * so plain string order puts the literal first — which is the rule the App
 * Router follows and the only thing the sort has to achieve.
 */
function shapeOf(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '1' : '0'))
    .join('');
}

/**
 * Orders the routes so a static segment always beats a `:param` one at the
 * first position where they differ.
 *
 * This compares whole **keys** rather than returning `0` for two unrelated
 * paths, and that is the entire point. The earlier version walked the segments
 * and returned `0` when neither side was more specific, which is not a total
 * order: it is not transitive, so `Array.prototype.sort` was free to produce
 * any arrangement consistent with the pairs it happened to compare. It did.
 * Adding an unrelated route elsewhere in the registry moved
 * `/api/v1/addresses/:id` in front of `/api/v1/addresses/default`, and the
 * literal route started answering `422` because `default` is not an id — a
 * failure in a file nobody had touched, caused by a file somewhere else.
 *
 * The path is the tie-break so the order is total and the mock server behaves
 * the same however the aggregation happens to be ordered.
 *
 * An earlier segment-walking variant that broke ties on the path was **still**
 * not transitive: a shorter all-static path
 * (`/admin-api/attachment-categories`) compared by path against a longer one
 * with a `:param` (`/admin-api/admins/:id`), while the longer static path
 * between them was ordered by segment — 2.5 M bad triples over 412 routes. The
 * key here is a (shape, path) tuple, which is a total order by construction;
 * `mock-server.test.ts` asserts it over the whole table.
 */
export function bySpecificity(a: CompiledRoute, b: CompiledRoute): number {
  const left = shapeOf(a.route.path);
  const right = shapeOf(b.route.path);
  if (left !== right) return left < right ? -1 : 1;
  if (a.route.path === b.route.path) return 0;
  return a.route.path < b.route.path ? -1 : 1;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fieldErrors(error: z.ZodError): Array<{ field: string; message: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return Symbol.for('mock.invalid-json');
  }
}

export function pickExample(route: AnyRouteDef, name: string | undefined): RouteExample | null {
  if (!name) return route.examples[0] ?? null;
  return route.examples.find((example) => example.name === name) ?? null;
}

/** Exported so a unit test can exercise the routing without a socket. */
export function matchRoute(
  compiled: readonly CompiledRoute[],
  method: string,
  pathname: string,
): { route: AnyRouteDef; params: Record<string, string> } | 'method-not-allowed' | null {
  let pathMatched = false;
  for (const candidate of compiled) {
    const match = candidate.regex.exec(pathname);
    if (!match) continue;
    pathMatched = true;
    if (candidate.route.method !== method) continue;
    const params: Record<string, string> = {};
    candidate.paramNames.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1] ?? '');
    });
    return { route: candidate.route, params };
  }
  return pathMatched ? 'method-not-allowed' : null;
}

export async function startMockServer(options: MockServerOptions = {}): Promise<RunningMockServer> {
  const routes = options.routes ?? allRoutes;
  // Static segments beat `:param` ones, as in the App Router: `/refunds/applicable-items`
  // must not be captured by `/refunds/:id`.
  const compiled = routes.map(compileRoute).sort(bySpecificity);

  const server = createServer((req, res) => {
    void handleRequest(req, res, compiled, options.verbose ?? false);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4010, options.host ?? '127.0.0.1', resolve);
  });

  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  compiled: readonly CompiledRoute[],
  verbose: boolean,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url ?? '/', 'http://mock.local');

  if (method === 'OPTIONS') {
    send(res, 204, null);
    return;
  }

  if (url.pathname === '/__mock/routes') {
    send(
      res,
      200,
      compiled.map((c) => ({
        id: c.route.id,
        method: c.route.method,
        path: c.route.path,
        examples: c.route.examples.map((e) => e.name),
      })),
    );
    return;
  }

  const matched = matchRoute(compiled, method, url.pathname);
  if (matched === null) {
    send(res, 404, { code: 'NOT_FOUND', message: '资源不存在', details: { path: url.pathname } });
    return;
  }
  if (matched === 'method-not-allowed') {
    send(res, 405, { code: 'NOT_FOUND', message: '资源不存在', details: { method } });
    return;
  }

  const { route, params } = matched;
  const problems: Array<{ field: string; message: string }> = [];

  if (route.params) {
    const parsed = route.params.safeParse(params);
    if (!parsed.success) problems.push(...fieldErrors(parsed.error));
  }
  if (route.query) {
    const query = Object.fromEntries(url.searchParams.entries());
    const parsed = route.query.safeParse(query);
    if (!parsed.success) problems.push(...fieldErrors(parsed.error));
  }
  if (route.body) {
    const body = await readBody(req);
    if (body === Symbol.for('mock.invalid-json')) {
      problems.push({ field: '<body>', message: '请求体不是合法的 JSON' });
    } else {
      const parsed = route.body.safeParse(body);
      if (!parsed.success) problems.push(...fieldErrors(parsed.error));
    }
  }

  if (problems.length > 0) {
    send(res, 422, { code: 'VALIDATION_FAILED', message: '提交的数据有误', details: problems });
    return;
  }

  const wanted = req.headers['x-mock-example'];
  const exampleName = Array.isArray(wanted) ? wanted[0] : wanted;
  const example = pickExample(route, exampleName);
  if (!example) {
    send(res, 404, {
      code: 'NOT_FOUND',
      message: '资源不存在',
      details: {
        reason: `no example named "${exampleName}"`,
        available: route.examples.map((e) => e.name),
      },
    });
    return;
  }

  if (verbose) {
    console.log(`${method} ${url.pathname} -> ${route.id} [${example.name}]`);
  }
  const status = route.status ?? 200;
  if (status === 204) {
    res.writeHead(204).end();
    return;
  }
  send(res, status, example.response);
}
