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
 */
export function boundContracts(source: string): string[] {
  return [...source.matchAll(/\bhandle\s*\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1] ?? '');
}
