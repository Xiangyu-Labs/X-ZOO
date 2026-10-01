import path from 'node:path';
import { defineCheck, fail, result, type Finding } from '../framework';
import { isTypeScript, walk } from '../lib/files';
import { rel, repoRoot } from '../lib/paths';
import { findPoolReaches, findTxFunctions, maskSource } from '../lib/tx-scan';

/**
 * No second pooled connection while a transaction is open.
 *
 * A function that holds a transaction and then reaches for the pool —
 * `ctx.config.get(…)` on a cache miss, `ctx.db`, a fresh `ctx.withTx(…)` —
 * needs two connections at once. As soon as `max` callers do that together,
 * every connection is held by a caller waiting for another one, and the pool
 * deadlocks. With a row lock in the picture it takes one hot row: a stock
 * reservation that did this wedged the concurrency soak (STAB-001), and would
 * wedge the web process in a flash sale. The pool gives up after
 * `DB_POOL_ACQUIRE_TIMEOUT_MS`, so the symptom is a burst of failed requests
 * instead of a dead process — still a defect.
 *
 * The fix at a site is to read through the transaction: `ctx.config.getIn(tx,
 * group)`, the repo call on `tx`, the work inside the same `withTx`.
 *
 * The allow-list is **exactly compared** on the trimmed source line: an entry
 * that no finding matches fails until it is deleted, so an entry cannot
 * outlive the line it excused, and editing an excused line makes it a finding
 * again, to be re-justified.
 */

interface Entry {
  /** Repo-relative file. */
  file: string;
  /** The trimmed source line, exactly. */
  text: string;
  why: string;
}

/** Reads proven harmless: before any lock, or never on a path that holds a transaction. */
const TX_POOL_ALLOW: readonly Entry[] = [];

const ROOTS = ['packages/core/src', 'apps/web/src', 'apps/web/app', 'apps/worker/src'];

const isSource = (name: string): boolean =>
  isTypeScript(name) && !name.endsWith('.tsx') && !/\.test\.ts$/.test(name);

export const txPool = defineCheck(
  'tx-pool',
  'no ctx.config.get / ctx.db / ctx.withTx inside a function that holds a transaction',
  () => {
    const findings: Finding[] = [];
    let files = 0;
    let functions = 0;
    const used = new Set<Entry>();

    for (const root of ROOTS) {
      for (const file of walk(path.join(repoRoot, root), isSource)) {
        files += 1;
        const where = rel(file.file);
        functions += findTxFunctions(maskSource(file.text)).length;
        for (const reach of findPoolReaches(file.text)) {
          const at = `${where}:${reach.line}`;
          const allowed = TX_POOL_ALLOW.find((e) => e.file === where && e.text === reach.text);
          if (allowed) {
            used.add(allowed);
            continue;
          }
          findings.push(
            fail(
              at,
              `\`${reach.construct}\` inside \`${reach.within}\`, which holds a transaction: a second pooled connection. Read through the transaction (\`ctx.config.getIn(tx, …)\`, the repo on \`tx\`), or add an exact TX_POOL_ALLOW entry saying why it is safe`,
            ),
          );
        }
      }
    }

    for (const entry of TX_POOL_ALLOW) {
      if (!used.has(entry)) {
        findings.push(
          fail(
            entry.file,
            `stale tx-pool entry, no such line any more: "${entry.text}" — delete it`,
          ),
        );
      }
    }

    return result(
      'tx-pool',
      'no second pooled connection inside a transaction',
      `${functions} functions holding a transaction in ${files} files; ${TX_POOL_ALLOW.length} allowed`,
      findings,
    );
  },
);
