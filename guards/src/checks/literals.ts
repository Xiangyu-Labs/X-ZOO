import path from 'node:path';
import type { z } from 'zod';
import { pageQuery } from '@shop/contracts/conventions';
import { allRoutes } from '@shop/contracts/routes';
import { defineCheck, fail, note, result, type Finding } from '../framework';
import { isTypeScript, lineOf, walk } from '../lib/files';
import { rel, repoRoot } from '../lib/paths';
import { maskSource } from '../lib/tx-scan';

/**
 * Two literals the shop kept getting wrong (AGENTS rules 2 and 4).
 *
 * **Page sizes.** A `pageSize` literal a caller sends must be one the contract
 * accepts. The cap is read from `pageQuery` in the contracts, not assumed; a
 * `pageSize: 200` in a picker is a 422 the first time an operator opens it.
 * Read in every client of the API: the admin, the mini-program, its two
 * shared packages, the CLI, the agent ops and the e2e helpers. Unit tests are
 * left out: their requests go through the contract-checked stubs
 * (`respondWith` / `serveApi`), which already refuse an over-cap page, and one
 * of them sends `pageSize: 200` on purpose to prove it.
 *
 * **Instants as dates.** `toISOString()` is UTC: cutting a date out of it
 * (`.slice(0, 10)`, `.split('T')`) puts an order placed at 00:30 in Shanghai on
 * the previous day, and so does slicing an instant field (`createdAt`) that
 * arrived as ISO text. Everywhere, a cut is a finding unless the expression
 * shifts to Shanghai first (it names an `offset` or `shifted`) or is excused.
 * In UI code `toISOString()` is only for the wire (query strings, cache keys,
 * a range sent to the API): each file that uses it is listed with the reason,
 * because what a person sees goes through `formatInstant` / `shopDateTime`.
 */

// ---------------------------------------------------------------------------
// Where
// ---------------------------------------------------------------------------

/** Callers of the API (their unit tests aside, see above). */
const CLIENT_ROOTS = [
  'apps/web/app',
  'apps/web/src',
  'apps/mini/src',
  'packages/storefront-blocks/src',
  'packages/api-client/src',
  'packages/admin-ops/src',
  'apps/cli/src',
  'e2e',
];

/** Code that turns instants into text. */
const CODE_ROOTS = [
  'packages/core/src',
  'apps/worker/src',
  'apps/web/app',
  'apps/web/src',
  'apps/mini/src',
  'packages/storefront-blocks/src',
  'packages/api-client/src',
  'packages/admin-ops/src',
  'apps/cli/src',
];

/** What renders in front of a person. */
const UI_ROOTS = [
  'apps/web/app/admin',
  'apps/web/src/admin',
  'apps/mini/src',
  'packages/storefront-blocks/src',
  'packages/api-client/src',
];

const isTest = (relative: string): boolean =>
  /\.(test|spec)\.tsx?$/.test(relative) || /(^|\/)(test|__fixtures__)\//.test(relative);

/** Dev-only screens and their canned data: never built into what staff or shoppers see. */
const isDevFixture = (relative: string): boolean =>
  /apps\/web\/app\/admin\/\(shell\)\/dev\//.test(relative) ||
  /apps\/mini\/src\/subpackages\/demo\//.test(relative);

// ---------------------------------------------------------------------------
// Page sizes
// ---------------------------------------------------------------------------

/** The largest `pageSize` the shared pagination schema accepts. */
export function pageSizeCap(schema: z.ZodType = pageQuery.shape.pageSize): number {
  let lo = 1;
  let hi = 100_000;
  if (!schema.safeParse(lo).success) return 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (schema.safeParse(mid).success) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface Literal {
  line: number;
  value: number;
  text: string;
}

/** `pageSize: 200`, `pageSize={200}`, `PAGE_SIZE = 200`, in code (not prose). */
export function pageSizeLiterals(source: string): Literal[] {
  const masked = maskSource(source);
  const out: Literal[] = [];
  for (const match of masked.matchAll(
    /\b(?:pageSize\s*(?::|=\s*\{?)|[A-Z_]*PAGE_SIZE\s*(?::\s*\w+\s*)?=)\s*(\d[\d_]*)\b/g,
  )) {
    out.push({
      line: lineOf(source, match.index),
      value: Number(match[1]!.replace(/_/g, '')),
      text: match[0].replace(/\s+/g, ' '),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Instants
// ---------------------------------------------------------------------------

export interface TimeCut {
  line: number;
  text: string;
  kind: 'utc-cut' | 'instant-slice' | 'ui-iso';
}

/** The expression a chained call hangs off, back to the start of its statement-ish. */
function receiverOf(masked: string, dot: number): string {
  let depth = 0;
  let i = dot - 1;
  for (; i >= 0; i -= 1) {
    const c = masked[i]!;
    if (c === ')' || c === ']' || c === '}') depth += 1;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && /[;,=:?\n]/.test(c) && !/[=!<>]/.test(masked[i + 1] ?? '')) break;
  }
  return masked.slice(i + 1, dot);
}

/** UTC dates cut from instants; `ui` adds every bare `toISOString()`. */
export function timeCuts(source: string, ui: boolean): TimeCut[] {
  const masked = maskSource(source);
  const out: TimeCut[] = [];
  const lineText = (at: number) => source.split('\n')[lineOf(source, at) - 1]!.trim();

  for (const match of masked.matchAll(/\.toISOString\(\)/g)) {
    const after = masked.slice(match.index + match[0].length);
    const cut = /^\s*(?:\?\.|\.)\s*(slice|substring|substr|split)\s*\(/.exec(after);
    if (cut) {
      const receiver = receiverOf(masked, match.index);
      if (/offset|shift/i.test(receiver)) continue;
      out.push({ line: lineOf(source, match.index), text: lineText(match.index), kind: 'utc-cut' });
    } else if (ui) {
      out.push({ line: lineOf(source, match.index), text: lineText(match.index), kind: 'ui-iso' });
    }
  }

  for (const match of masked.matchAll(
    /\b[a-z]\w*At\s*(?:\?\.|\.)\s*(?:slice|substring|substr)\(\s*0\s*,\s*(?:10|16|19)\s*\)/g,
  )) {
    out.push({
      line: lineOf(source, match.index),
      text: lineText(match.index),
      kind: 'instant-slice',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Allow-lists (exactly compared)
// ---------------------------------------------------------------------------

interface CutEntry {
  file: string;
  /** Trimmed source line, exactly. */
  text: string;
  why: string;
}

/** A UTC date cut that is meant to be UTC. */
export const UTC_CUT_ALLOW: readonly CutEntry[] = [
  {
    file: 'packages/core/src/sms/sms-tencent.ts',
    text: 'const date = new Date(timestamp * 1000).toISOString().slice(0, 10);',
    why: 'Tencent Cloud TC3-HMAC-SHA256 signs the UTC date of the request timestamp',
  },
];

/** UI files whose `toISOString()` only ever goes onto the wire. */
export const UI_ISO_FILES: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'apps/web/src/admin/api/query-keys.ts',
    why: 'a Date query parameter as a cache key',
  },
  { file: 'apps/web/src/admin/api/url.ts', why: 'a Date query parameter in the URL' },
  {
    file: 'apps/web/src/admin/stats/use-stats-range.ts',
    why: 'the picked range sent to the stats routes (Shanghai day bounds)',
  },
  {
    file: 'apps/web/src/admin/stats/stats-page.tsx',
    why: 'an instant handed to formatInstant, which renders it in Shanghai',
  },
  { file: 'packages/api-client/src/url.ts', why: 'a Date query parameter in the URL' },
  {
    file: 'packages/api-client/src/query-keys.ts',
    why: 'a Date query parameter as a cache key',
  },
];

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

const isSource = (name: string): boolean => isTypeScript(name) && !name.endsWith('.gen.ts');

export const literals = defineCheck(
  'literals',
  'page sizes the contract accepts; no UTC date cut from an instant; no toISOString shown in UI',
  () => {
    const findings: Finding[] = [];
    const cap = pageSizeCap();

    // Routes that cap pageSize tighter than the shared schema: their literals
    // are checked against the shared cap only, so say which they are.
    for (const route of allRoutes) {
      const query = route.query as z.ZodObject | undefined;
      const own = (query?.shape as Record<string, z.ZodType> | undefined)?.pageSize;
      if (own && !own.safeParse(cap).success) {
        findings.push(
          note(
            route.id,
            `caps pageSize below ${cap}; literals sent to it are checked against ${cap}`,
          ),
        );
      }
    }

    let pageSizes = 0;
    const seen = new Set<string>();
    for (const root of CLIENT_ROOTS) {
      for (const file of walk(path.join(repoRoot, root), isSource)) {
        const where = rel(file.file);
        if (seen.has(where) || /\.test\.tsx?$/.test(where)) continue;
        seen.add(where);
        for (const literal of pageSizeLiterals(file.text)) {
          pageSizes += 1;
          if (literal.value >= 1 && literal.value <= cap) continue;
          findings.push(
            fail(
              `${where}:${literal.line}`,
              `\`${literal.text}\` is outside 1..${cap}, the pageSize the contracts accept (pageQuery); the server answers 422 (AGENTS rule 4)`,
            ),
          );
        }
      }
    }

    const cutUsed = new Set<CutEntry>();
    const uiFilesUsed = new Set<string>();
    let cuts = 0;
    const scanned = new Set<string>();
    for (const root of CODE_ROOTS) {
      for (const file of walk(path.join(repoRoot, root), isSource)) {
        const where = rel(file.file);
        if (scanned.has(where) || isTest(where) || isDevFixture(where)) continue;
        scanned.add(where);
        const ui = UI_ROOTS.some((r) => where.startsWith(`${r}/`));
        for (const cut of timeCuts(file.text, ui)) {
          cuts += 1;
          if (cut.kind === 'ui-iso') {
            if (UI_ISO_FILES.some((entry) => entry.file === where)) {
              uiFilesUsed.add(where);
              continue;
            }
            findings.push(
              fail(
                `${where}:${cut.line}`,
                `\`${cut.text}\` — toISOString() in UI code is UTC. Show instants with formatInstant; if this only goes onto the wire, add the file to UI_ISO_FILES with the reason (AGENTS rule 2)`,
              ),
            );
            continue;
          }
          const allowed = UTC_CUT_ALLOW.find((e) => e.file === where && e.text === cut.text);
          if (allowed) {
            cutUsed.add(allowed);
            continue;
          }
          findings.push(
            fail(
              `${where}:${cut.line}`,
              cut.kind === 'utc-cut'
                ? `\`${cut.text}\` cuts a date out of a UTC instant: 00:30 in Shanghai becomes yesterday. Use shopDay / shopDateTime (kernel/shop-time) or dayjs.tz, or add an exact UTC_CUT_ALLOW entry if UTC is meant (AGENTS rule 2)`
                : `\`${cut.text}\` slices an instant's ISO text, which is UTC: the date is wrong for eight hours a day. Format it with formatInstant / shopDay instead (AGENTS rule 2)`,
            ),
          );
        }
      }
    }

    for (const entry of UTC_CUT_ALLOW) {
      if (!cutUsed.has(entry)) {
        findings.push(
          fail(
            entry.file,
            `UTC_CUT_ALLOW excuses \`${entry.text}\`, which no finding matches any more — delete the entry`,
          ),
        );
      }
    }
    for (const entry of UI_ISO_FILES) {
      if (!uiFilesUsed.has(entry.file)) {
        findings.push(
          fail(
            entry.file,
            'UI_ISO_FILES lists this file, which no longer calls toISOString() — delete the entry',
          ),
        );
      }
    }

    return result(
      'literals',
      'page sizes and instants',
      `${pageSizes} pageSize literal(s) against the contract cap ${cap}; ${cuts} toISOString / instant cut(s) in ${scanned.size} files, ${UTC_CUT_ALLOW.length} UTC cut(s) and ${UI_ISO_FILES.length} wire-only UI file(s) excused`,
      findings,
    );
  },
);
