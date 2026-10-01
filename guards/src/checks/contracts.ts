import path from 'node:path';
import { allRoutes, routeSources } from '@shop/contracts/routes';
import { defineCheck, fail, note, result, type Finding } from '../framework';
import { stripComments, walk } from '../lib/files';
import { rel, webApp } from '../lib/paths';
import {
  exportedMethods,
  paramsOf,
  shapeOf,
  urlOfRouteFile,
  type Method,
} from '../lib/route-files';

/**
 * ROUTE-001, both ways round.
 *
 * The contract is the registry, the directory is the router, and the two must
 * agree exactly:
 *
 *   - every contract resolves to a `route.ts` that exports its method;
 *   - every exported method of every `route.ts` is described by a contract;
 *   - the folder's parameter name is the contract's parameter name, because
 *     `handle()` feeds `params` straight into the contract's zod schema — a
 *     `[couponId]` folder under a `:id` contract is a 422 on every request.
 */

/**
 * Route files that deliberately have no contract, named one by one.
 *
 * There is exactly one, and it is a decision rather than an oversight:
 * `defineRoute` describes a request and a response body, and an SSE stream has
 * neither — it has a long-lived `text/event-stream` and a sequence of events.
 * The endpoint is a bare handler for that reason (the file's own header says
 * so), and the admin client carries the matching exception in
 * `checks/admin-client.ts` (`HAND_BUILT`), so both ends of the one
 * uncontracted URL are written down in the two places a reader would look.
 *
 * What the registry would have given it, the guard asks for instead. A bare
 * handler does not pass through `handle()`, so nothing resolves the admin
 * session for it: `authenticates` is the call that has to be in the file, and
 * a bare handler without it is a failure — an event stream anybody can open
 * is every admin's notifications on the open internet.
 *
 * Exactly compared both ways: an entry whose route file stops exporting the
 * method, or whose URL grows a contract, fails until it is deleted.
 */
const UNCONTRACTED: ReadonlyArray<{
  url: string;
  method: Method;
  authenticates: RegExp;
  why: string;
}> = [
  {
    url: '/admin-api/notifications/stream',
    method: 'GET',
    authenticates: /\.adminAuth\.resolve\s*\(/,
    why: 'the in-app notification SSE stream — defineRoute cannot describe an event stream, so the URL is outside the registry',
  },
];

interface RouteFile {
  relative: string;
  url: string;
  methods: Method[];
  text: string;
}

export function collectRouteFiles(): RouteFile[] {
  const appDir = path.join(webApp, 'app');
  return walk(appDir, (name) => name === 'route.ts')
    .filter((f) => f.relative.startsWith('admin-api/') || f.relative.startsWith('api/'))
    .map((f) => ({
      relative: rel(f.file),
      url: urlOfRouteFile(f.relative),
      methods: exportedMethods(f.text),
      text: f.text,
    }));
}

export const contractsAndRoutes = defineCheck(
  'contracts',
  'every contract has a route file and every route file has a contract',
  () => {
    const files = collectRouteFiles();
    const findings: Finding[] = [];

    const byShape = new Map<string, RouteFile>();
    for (const file of files) {
      const shape = shapeOf(file.url);
      const clash = byShape.get(shape);
      if (clash) {
        findings.push(
          fail(file.relative, `two route files claim the same URL shape as ${clash.relative}`),
        );
        continue;
      }
      byShape.set(shape, file);
      if (file.methods.length === 0) {
        findings.push(fail(file.relative, 'exports no HTTP method'));
      }
    }

    const served = new Set<string>();
    for (const route of allRoutes) {
      const shape = shapeOf(route.path);
      const file = byShape.get(shape);
      if (!file) {
        findings.push(
          fail(
            routeSources[route.id] ?? route.id,
            `${route.method} ${route.path} (${route.id}) has no route file — expected ${expectedFile(route.path)}`,
          ),
        );
        continue;
      }
      if (!file.methods.includes(route.method as Method)) {
        findings.push(
          fail(file.relative, `does not export ${route.method}, which ${route.id} declares`),
        );
        continue;
      }
      served.add(`${route.method} ${shape}`);

      const contractParams = paramsOf(route.path);
      const fileParams = paramsOf(file.url);
      for (const [i, name] of contractParams.entries()) {
        if (fileParams[i] !== name) {
          findings.push(
            fail(
              file.relative,
              `folder parameter [${fileParams[i] ?? '?'}] does not match the contract's :${name} (${route.id}) — handle() parses params by name`,
            ),
          );
        }
      }
    }

    const uncontractedHit = new Set<string>();
    for (const file of files) {
      for (const method of file.methods) {
        if (served.has(`${method} ${shapeOf(file.url)}`)) continue;
        const known = UNCONTRACTED.find(
          (e) => e.method === method && shapeOf(e.url) === shapeOf(file.url),
        );
        if (known) {
          uncontractedHit.add(`${known.method} ${known.url}`);
          if (!known.authenticates.test(stripComments(file.text))) {
            findings.push(
              fail(
                file.relative,
                `${method} ${file.url} is served outside handle() and no longer resolves the admin session itself (${known.authenticates.source})`,
              ),
            );
            continue;
          }
          findings.push(note(file.relative, `${method} ${file.url} — ${known.why}`));
          continue;
        }
        findings.push(
          fail(file.relative, `exports ${method} ${file.url}, which no contract describes`),
        );
      }
    }

    for (const entry of UNCONTRACTED) {
      if (uncontractedHit.has(`${entry.method} ${entry.url}`)) continue;
      findings.push(
        fail(
          entry.url,
          `is listed as deliberately uncontracted but no route file serves ${entry.method} for it outside a contract any more — delete the entry`,
        ),
      );
    }

    const handlers = files.reduce((n, f) => n + f.methods.length, 0);
    return result(
      'contracts',
      'contracts <-> route files',
      `${allRoutes.length} contracts against ${files.length} route files (${handlers} exported handlers)`,
      findings,
    );
  },
);

function expectedFile(contractPath: string): string {
  const segments = contractPath.split('/').filter(Boolean);
  const dirs = segments.map((s) => (s.startsWith(':') ? `[${s.slice(1)}]` : s));
  return `apps/web/app/${dirs.join('/')}/route.ts`;
}
