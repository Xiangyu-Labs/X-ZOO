/**
 * The App Router directory *is* the URL, so a route file's location and a
 * contract's `path` are two spellings of one fact. These helpers turn each into
 * the other so the guard can compare them without a Next.js build.
 */
import { stripComments } from './files';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type Method = (typeof HTTP_METHODS)[number];

const MUTATING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMutating(method: string): boolean {
  return MUTATING.has(method);
}

/**
 * `admin-api/coupons/[id]/status/route.ts` -> `/admin-api/coupons/:id/status`.
 *
 * Route groups (`(shell)`) and private folders (`_lib`) never appear under
 * `app/admin-api` or `app/api`, but they are skipped anyway so that a future
 * one cannot silently shift every URL.
 */
export function urlOfRouteFile(relativeToApp: string): string {
  const segments = relativeToApp.split('/').slice(0, -1); // drop `route.ts`
  const out: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith('(') && segment.endsWith(')')) continue;
    if (segment.startsWith('_')) continue;
    if (segment.startsWith('[') && segment.endsWith(']')) {
      const inner = segment.slice(1, -1);
      out.push(`:${inner.replace(/^\.\.\./, '...')}`);
    } else out.push(segment);
  }
  return `/${out.join('/')}`;
}

/** `/admin-api/coupons/:id` -> `/admin-api/coupons/:param`, for shape comparison. */
export function shapeOf(url: string): string {
  return url.replace(/:[A-Za-z0-9_]+/g, ':param').replace(/\/+$/, '') || '/';
}

/** The parameter names of a path, in order: `/a/:id/b/:token` -> `['id','token']`. */
export function paramsOf(url: string): string[] {
  return [...url.matchAll(/:([A-Za-z0-9_.]+)/g)].map((m) => m[1] ?? '');
}

/** The HTTP methods a route file exports. */
export function exportedMethods(source: string): Method[] {
  const found = new Set<Method>();
  for (const method of HTTP_METHODS) {
    const re = new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${method}\\b`);
    if (re.test(source)) found.add(method);
  }
  return HTTP_METHODS.filter((m) => found.has(m));
}

/** Whether the file declares the dynamic rendering mode every API route needs. */
export function declaresForceDynamic(source: string): boolean {
  return /export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/.test(source);
}

/**
 * Whether a handler names what it acted on for the audit log.
 *
 * Comments are stripped first: a handler that *mentions* `ctx.audit` in a note
 * about why it does not call it would otherwise satisfy the guard, which is the
 * one way this assertion could be quietly wrong.
 */
export function namesAuditTarget(source: string): boolean {
  return /\bctx\.audit\s*\(/.test(stripComments(source));
}

/**
 * The contract identifiers a route file binds, in `handle(<name>, …)` position.
 * Used to check that the file serves the contract whose path it sits on.
 *
 * Comments are stripped first: a note that mentions `handle(listCoupons, …)`
 * must not count as a binding.
 */
export function boundContracts(source: string): string[] {
  const text = stripComments(source);
  return [...text.matchAll(/\bhandle\s*\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1] ?? '');
}

/**
 * The source of each exported HTTP method: from its `export` keyword up to the
 * next exported method. Enough to ask a per-method question (does *this* write
 * call `ctx.audit`?) without a TypeScript parser, and comments are stripped so
 * a commented-out call cannot answer for a live one.
 */
export function methodBodies(source: string): Partial<Record<Method, string>> {
  const text = stripComments(source);
  const starts: { method: Method; index: number }[] = [];
  for (const method of HTTP_METHODS) {
    const re = new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${method}\\b`, 'g');
    for (const match of text.matchAll(re)) starts.push({ method, index: match.index ?? 0 });
  }
  starts.sort((a, b) => a.index - b.index);
  const bodies: Partial<Record<Method, string>> = {};
  for (const [i, start] of starts.entries()) {
    const end = starts[i + 1]?.index ?? text.length;
    bodies[start.method] = text.slice(start.index, end);
  }
  return bodies;
}

/**
 * The contract each exported method binds through `handle()`, keyed by method.
 *
 * `boundContracts` cannot tell which method a name belongs to; in a file that
 * exports `PUT` and `DELETE` it only says the file names two contracts. This
 * associates each name with the method whose body contains it, which is what
 * the contracts guard compares against the URL's route.
 */
export function boundContractsByMethod(source: string): Partial<Record<Method, string>> {
  const bodies = methodBodies(source);
  const out: Partial<Record<Method, string>> = {};
  for (const [method, body] of Object.entries(bodies) as [Method, string][]) {
    const match = /\bhandle\s*\(\s*([A-Za-z_$][\w$]*)/.exec(body);
    if (match?.[1] !== undefined) out[method] = match[1];
  }
  return out;
}

/**
 * The route ids a bare handler names in `ctxFor(request, '<route.id>')`.
 *
 * The two WeChat webhooks answer with WeChat's own text/XML rather than the
 * JSON envelope `handle()` validates, so they create their context by hand and
 * name the contract themselves. Extracted so the guard can check that name.
 */
export function ctxRouteIds(source: string): string[] {
  const text = stripComments(source);
  return [...text.matchAll(/ctxFor\s*\(\s*[^,]+,\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
}
