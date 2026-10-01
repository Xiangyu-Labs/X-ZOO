import path from 'node:path';
import { allRoutes } from '@shop/contracts/routes';
import { defineCheck, fail, result, type Finding } from '../framework';
import { lineOf, stripComments, walk } from '../lib/files';
import { rel, repoRoot } from '../lib/paths';
import { shapeOf } from '../lib/route-files';

/**
 * "Every URL the admin client can call resolves to a registered route."
 *
 * The admin UI calls `callRoute(routeDef, …)` and the URL is *derived* from the
 * contract, so the property is true by construction and what is left to guard
 * is the construction itself. (An admin that builds URLs as strings needs a
 * parser for every `url:` literal and still only sees the literals; this one
 * never has to.)
 *
 *   1. no API path literal outside the api seam — a hand-built `/admin-api/…`
 *      string is a URL no contract checks, which can drift from the route it
 *      meant;
 *   2. no `fetch(` in a page or a component — data goes through the generated
 *      hooks, and the one allowed caller is `call-route.ts` itself.
 *
 * Together those two mean every reachable admin URL came out of a `RouteDef`,
 * which the contracts check has already matched to a route file.
 */

const API_SEAM: readonly RegExp[] = [
  /^apps\/web\/src\/admin\/api\//, // callRoute + config: the seam itself
  /^apps\/web\/src\/server\//, // server-side, not the browser client
  /\.test\.tsx?$/,
  /^apps\/web\/app\/admin\/\(shell\)\/dev\/kit\//, // the kit demo's in-memory fake fetch
];

const UI_ROOTS = ['apps/web/src/admin', 'apps/web/app/admin'];

/**
 * The one URL the admin UI is allowed to build by hand, and why.
 *
 * A server-sent-event stream has no request body and no response body, so
 * `RouteDef` cannot describe it and `callRoute` cannot call it — P0-B recorded
 * this as the single exception (`status/p0b.md`), and N1 shipped the server
 * end as a bare handler for the same reason (`checks/contracts.ts`,
 * `UNCONTRACTED`, which also asserts that handler authenticates by itself).
 *
 * A decision, not a debt: it is listed so that it stays single and stays in
 * the one file that owns it. Exactly compared — if nothing builds the URL any
 * more, or if the URL grows a contract (and so could go through the seam like
 * everything else), the entry fails until it is deleted.
 */
const HAND_BUILT: ReadonlyArray<{ url: string; where: RegExp; why: string }> = [
  {
    url: '/admin-api/notifications/stream',
    where: /notifications\/notification-bell\.tsx$/,
    why: 'the SSE stream: EventSource, no contract body to describe',
  },
];

export const adminClient = defineCheck(
  'admin-client',
  'the admin UI reaches the API only through the contract client',
  () => {
    const findings: Finding[] = [];
    const known = new Set(allRoutes.map((r) => shapeOf(r.path)));
    const seenExceptions = new Set<string>();
    let scanned = 0;

    for (const root of UI_ROOTS) {
      for (const file of walk(path.join(repoRoot, root), (n) => /\.(ts|tsx)$/.test(n))) {
        const where = rel(file.file);
        if (API_SEAM.some((re) => re.test(where))) continue;
        scanned += 1;
        // Prose about a route is not a call to it: half the admin's doc comments
        // name the URL they are about.
        const code = stripComments(file.text);

        for (const match of code.matchAll(/['"`](\/(?:admin-api|api\/v1)\/[^'"`]*)['"`]/g)) {
          const url = match[1] ?? '';
          const exception = HAND_BUILT.find((e) => e.url === url && e.where.test(where));
          if (exception) {
            seenExceptions.add(exception.url);
            if (known.has(shapeOf(url))) {
              findings.push(
                fail(
                  `${where}:${lineOf(code, match.index)}`,
                  `builds "${url}" by hand, but it has a contract now — call it through callRoute and delete the HAND_BUILT entry`,
                ),
              );
            }
            continue;
          }
          findings.push(
            fail(
              `${where}:${lineOf(code, match.index)}`,
              `builds the API path "${url}" by hand — call the contract through callRoute/useRouteQuery`,
            ),
          );
        }
        for (const match of code.matchAll(/(^|[^.\w])fetch\s*\(/g)) {
          findings.push(
            fail(
              `${where}:${lineOf(code, match.index)}`,
              'calls fetch() directly — admin data access goes through the generated hooks',
            ),
          );
        }
      }
    }

    for (const exception of HAND_BUILT) {
      if (!seenExceptions.has(exception.url)) {
        findings.push(
          fail(
            exception.url,
            'is on the hand-built URL list but nothing builds it any more — delete the entry',
          ),
        );
      }
    }

    return result(
      'admin-client',
      'admin client',
      `${scanned} admin UI files checked for hand-built API URLs and raw fetch (${HAND_BUILT.length} documented exception)`,
      findings,
    );
  },
);
