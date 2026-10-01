import path from 'node:path';
import { defineCheck, fail, result, type Finding } from '../framework';
import { isTypeScript, lineOf, walk } from '../lib/files';
import { rel, repoRoot } from '../lib/paths';
import { maskSource, matching } from '../lib/tx-scan';

/**
 * Counters move by `sql` increment, never by writing back a number (AGENTS
 * rule 6).
 *
 * Stock, sales, quota and the refunded / shipped quantities are moved by
 * concurrent requests. `set({ stock: current - n })` with `current` read a
 * moment earlier loses every order that committed in between; the fix is
 * `set({ stock: sql\`${t.stock} - ${n}\` })` under a guarded `WHERE`. This check
 * reads every Drizzle `.set({…})` and `onConflictDoUpdate({ set: {…} })` in
 * the server code and fails on a counter column assigned anything but:
 *
 *  - a `sql` template (an increment, a recount, a `greatest(…)`);
 *  - a number literal (a reset: `attempts: 0`);
 *  - a value in a statement whose `where` reads the same column — the
 *    compare-and-set `where(eq(t.stock, expected)).set({ stock: next })`,
 *    which writes nothing when somebody else moved it.
 *
 * Anything else needs a `COUNTER_ALLOW` entry, keyed on the file and the
 * trimmed assignment text and exactly compared (an entry no finding uses
 * fails), saying why the number cannot be stale.
 *
 * Lexical, like `tx-pool`: it sees the object literal written at the call, not
 * a `set(values)` whose object was built elsewhere.
 */

/** Columns that concurrent requests move (packages/db/src/schema). */
export const COUNTER_COLUMNS: readonly string[] = [
  'stock',
  'sales',
  'quota',
  'remainingCount',
  'issuedCount',
  'usedCount',
  'claimedCount',
  'refundedQuantity',
  'shippedQuantity',
  'seatsTaken',
  'scanCount',
  'followCount',
  'views',
];

interface Entry {
  file: string;
  /** The trimmed `key: value` text, exactly. */
  text: string;
  why: string;
}

export const COUNTER_ALLOW: readonly Entry[] = [
  {
    file: 'packages/core/src/groupbuy/groupbuy.repo.ts',
    text: 'stock: sku.stock',
    why: 'an activity edit: the service resolved each SKU stock against the rows it locked (kernel/stock-edit resolveActivityStocks), so the number is the locked truth or the operator’s deliberate change',
  },
  {
    file: 'packages/core/src/groupbuy/groupbuy.repo.ts',
    text: 'quota: sku.quota',
    why: 'the per-SKU cap the operator typed on the activity form, not a running count',
  },
  {
    file: 'packages/core/src/presale/presale.repo.ts',
    text: 'stock: sku.stock',
    why: 'an activity edit: the service resolved each SKU stock against the rows it locked (kernel/stock-edit resolveActivityStocks)',
  },
  {
    file: 'packages/core/src/presale/presale.repo.ts',
    text: 'quota: sku.quota',
    why: 'the per-SKU cap the operator typed on the activity form, not a running count',
  },
  {
    file: 'packages/core/src/refund/refund.repo.ts',
    text: 'refundedQuantity: counted',
    why: '`counted` is a SQL subquery that recounts the settled refund lines inside the UPDATE, under a WHERE that bounds it — not a number read earlier',
  },
];

const ROOTS = ['packages/core/src', 'apps/worker/src', 'apps/web/src/server'];

const isSource = (name: string): boolean =>
  isTypeScript(name) && !name.endsWith('.tsx') && !/\.test\.ts$/.test(name);

export interface CounterWrite {
  line: number;
  key: string;
  /** Trimmed `key: value` as written. */
  text: string;
}

/** Top-level `key: value` pairs of the object literal whose `{` is at `open`. */
function propsOf(
  masked: string,
  source: string,
  open: number,
): { key: string; value: string; text: string; at: number }[] {
  const close = matching(masked, open);
  if (close < 0) return [];
  const out: { key: string; value: string; text: string; at: number }[] = [];
  let depth = 0;
  let start = open + 1;
  const flush = (end: number) => {
    const raw = masked.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const at = start + lead;
    const match = /^([A-Za-z_$][\w$]*)\s*(?::\s*([\s\S]*))?$/.exec(raw.trim());
    if (match) {
      out.push({
        key: match[1]!,
        value: (match[2] ?? match[1]!).trim(),
        text: source.slice(at, end).trim().replace(/\s+/g, ' ').replace(/,$/, ''),
        at,
      });
    }
    start = end + 1;
  };
  for (let i = open + 1; i < close; i += 1) {
    const c = masked[i]!;
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) flush(i);
  }
  flush(close);
  return out;
}

/** The statement around `at`: from the previous `;` to the next one. */
function statementAround(masked: string, at: number): string {
  const from = masked.lastIndexOf(';', at) + 1;
  const to = masked.indexOf(';', at);
  return masked.slice(from, to < 0 ? masked.length : to);
}

/** Counter columns assigned something that may be a stale number. */
export function findCounterWrites(source: string): CounterWrite[] {
  const masked = maskSource(source);
  const out: CounterWrite[] = [];
  for (const match of masked.matchAll(/\.set\(\s*\{|\bset:\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    const close = matching(masked, open);
    for (const prop of propsOf(masked, source, open)) {
      if (!COUNTER_COLUMNS.includes(prop.key)) continue;
      if (/^sql\b/.test(prop.value)) continue;
      if (/^-?\d+$/.test(prop.value)) continue;
      const statement = statementAround(masked, open);
      const outside =
        statement.slice(0, open - (masked.lastIndexOf(';', open) + 1)) +
        statement.slice(close - (masked.lastIndexOf(';', open) + 1));
      if (/\bwhere\b/.test(outside) && new RegExp(`\\.${prop.key}\\b`).test(outside)) continue;
      out.push({ line: lineOf(source, prop.at), key: prop.key, text: prop.text });
    }
  }
  return out;
}

export const counters = defineCheck(
  'counters',
  'counter columns move by sql increment or a guarded WHERE, never by a number written back',
  () => {
    const findings: Finding[] = [];
    const used = new Set<Entry>();
    let files = 0;
    let writes = 0;
    for (const root of ROOTS) {
      for (const file of walk(path.join(repoRoot, root), isSource)) {
        files += 1;
        const where = rel(file.file);
        for (const write of findCounterWrites(file.text)) {
          writes += 1;
          const allowed = COUNTER_ALLOW.find((e) => e.file === where && e.text === write.text);
          if (allowed) {
            used.add(allowed);
            continue;
          }
          findings.push(
            fail(
              `${where}:${write.line}`,
              `\`${write.text}\` writes a counter back as a number. Move it with sql (\`${write.key}: sql\`\${t.${write.key}} - \${n}\`\`), or guard the statement with \`where(eq(t.${write.key}, expected))\`; if the number cannot be stale, add an exact COUNTER_ALLOW entry saying why (AGENTS rule 6)`,
            ),
          );
        }
      }
    }
    for (const entry of COUNTER_ALLOW) {
      if (!used.has(entry)) {
        findings.push(
          fail(
            entry.file,
            `COUNTER_ALLOW excuses \`${entry.text}\`, which no counter write matches any more — delete the entry`,
          ),
        );
      }
    }
    return result(
      'counters',
      'counter writes',
      `${files} server files; ${writes} counter assignment(s) that are not sql, a literal or compare-and-set, ${COUNTER_ALLOW.length} excused`,
      findings,
    );
  },
);
