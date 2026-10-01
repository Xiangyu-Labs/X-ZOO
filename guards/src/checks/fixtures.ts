import path from 'node:path';
import { defineCheck, fail, result, type Finding } from '../framework';
import { lineOf, stripComments, walk } from '../lib/files';
import { rel, webApp } from '../lib/paths';

/**
 * "A component test answers a request only with what the contract allows."
 *
 * An admin component test stubs the transport and hands the component an
 * object. Serialised to JSON, that object is never compared to anything, so a
 * fixture can miss a required field, keep one the contract dropped, or use the
 * wrong shape for a nested object — and the test still passes until a
 * component happens to read the missing part, which may depend on timing.
 *
 * `apps/web/src/test/api.ts` closes that: `stubRoutes([on(route, value)])` and
 * `respondWith(route, value)` parse every fixture with the route's response
 * schema, and `respondWithError` checks the error envelope. This check keeps it
 * the only way, over every `*.test.ts(x)` in the web app:
 *
 *   1. no `configureApi({ fetch … })` — the stub comes from `stubRoutes`;
 *   2. no hand-built `Response` (`new Response(`, `Response.json(`) in a test
 *      that points the admin client anywhere.
 */

/** The seam itself: it builds the checked `Response`s everyone else uses. */
const SEAM = /^src\/test\//;

/**
 * Tests that genuinely need a body the contract cannot describe, and why.
 * Exactly compared: an entry whose file no longer does it fails until deleted.
 */
const RAW_ALLOWED: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'src/admin/api/call-route.test.ts',
    why: 'tests the client transport itself: an HTML 502, an empty 204, a body that is not JSON',
  },
];

const CONFIGURE_FETCH = /\bconfigureApi\s*\(\s*\{[^}]*\bfetch\b/g;
const RAW_RESPONSE = /\bnew\s+Response\s*\(|\bResponse\.json\s*\(/g;
const POINTS_CLIENT = /\b(configureApi|stubRoutes)\s*\(/;

export interface FixtureScan {
  configuresFetch: number[];
  rawResponses: number[];
}

/** Line numbers of each kind of hand-made answer in one test file's source. */
export function scanTestSource(source: string): FixtureScan {
  const code = stripComments(source);
  const lines = (re: RegExp): number[] =>
    [...code.matchAll(re)].map((match) => lineOf(code, match.index));
  return {
    configuresFetch: lines(CONFIGURE_FETCH),
    rawResponses: POINTS_CLIENT.test(code) ? lines(RAW_RESPONSE) : [],
  };
}

export const fixtures = defineCheck(
  'fixtures',
  'component-test fixtures go through the contract they answer',
  () => {
    const findings: Finding[] = [];
    const seen = new Set<string>();
    let scanned = 0;

    for (const file of walk(webApp, (name) => /\.test\.tsx?$/.test(name))) {
      if (SEAM.test(file.relative)) continue;
      scanned += 1;
      const where = rel(file.file);
      const scan = scanTestSource(file.text);
      const allowed = RAW_ALLOWED.find((entry) => entry.file === file.relative);
      if (allowed) {
        if (scan.configuresFetch.length + scan.rawResponses.length > 0) seen.add(allowed.file);
        continue;
      }
      for (const line of scan.configuresFetch) {
        findings.push(
          fail(
            `${where}:${line}`,
            'stubs fetch through configureApi — answer with stubRoutes([on(route, fixture)]) from @/test/api, which checks the fixture against the contract',
          ),
        );
      }
      for (const line of scan.rawResponses) {
        findings.push(
          fail(
            `${where}:${line}`,
            'builds a Response by hand — use respondWith(route, value) or respondWithError(status, body) from @/test/api',
          ),
        );
      }
    }

    for (const entry of RAW_ALLOWED) {
      if (!seen.has(entry.file)) {
        findings.push(
          fail(
            path.posix.join(rel(webApp), entry.file),
            'is on the raw-response list but no longer builds one — delete the entry',
          ),
        );
      }
    }

    return result(
      'fixtures',
      'fixtures',
      `${scanned} web test files checked for fixtures that bypass the contract (${RAW_ALLOWED.length} documented exception)`,
      findings,
    );
  },
);
