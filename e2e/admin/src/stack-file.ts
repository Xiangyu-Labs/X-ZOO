import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The handoff between `scripts/serve.ts` (which owns the containers) and the
 * specs (which need the same database to arrange fixtures and to read back
 * audit rows).
 *
 * A file rather than an environment variable, because Playwright spawns the
 * `webServer` command as a child: the parent cannot read anything the child
 * later discovers, and the ports are only known once the containers are up.
 *
 * It lives in the system temp directory, not in the repository, so no run can
 * leave something behind that `git status` would show or `prettier` would
 * reformat.
 *
 * ## One checkout, one stack
 *
 * Several checkouts of this repository (worktrees) run the suite on the same
 * machine at the same time. With one fixed port and one fixed stack file they
 * would find each other: the second run's Playwright would see a server
 * already answering on the port, reuse it, and run its specs against the
 * *first* checkout's build and database — green or red for reasons that had nothing
 * to do with its own code. So:
 *
 * - the default port and stack file are derived from the checkout's path
 *   (`CHECKOUT_ID` below), so two checkouts never share either by default;
 * - reusing a server that is already up is opt-in, `SHOP_E2E_REUSE=1`
 *   (`playwright.config.ts`); without it a busy port is an error, not a
 *   silent handover;
 * - `SHOP_E2E_PORT` and `SHOP_E2E_STACK` still override both, e.g. to run
 *   the same checkout twice.
 */

/** The checkout root, resolved from this file. */
export const CHECKOUT_ROOT = path.resolve(import.meta.dirname, '../../..');

/** Eight hex digits of the checkout path's SHA-256: stable per checkout, distinct across them. */
export const CHECKOUT_ID = createHash('sha256').update(CHECKOUT_ROOT).digest('hex').slice(0, 8);

/**
 * 20000–24999: below Linux's ephemeral range (32768+), above the usual dev
 * servers. 5000 slots make a clash between a handful of worktrees unlikely,
 * and a clash is loud (the port is busy), never a silent reuse.
 */
const DEFAULT_PORT = 20_000 + (Number.parseInt(CHECKOUT_ID, 16) % 5_000);

export const STACK_FILE =
  process.env.SHOP_E2E_STACK ?? path.join(tmpdir(), `shop-e2e-admin-${CHECKOUT_ID}.json`);

export const PORT = Number(process.env.SHOP_E2E_PORT ?? DEFAULT_PORT);

/** Opt-in: attach to a server already answering on `PORT` instead of starting one. */
export const REUSE = process.env.SHOP_E2E_REUSE === '1';

export const BASE_URL = process.env.SHOP_E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

/** Everything the specs need that only the serve script can know. */
export interface StackInfo {
  /** The database the server is talking to. */
  databaseUrl: string;
  /** The Redis the server is talking to, including the logical db index. */
  redisUrl: string;
  baseUrl: string;
  /** Where uploads land, so a spec can assert a file really was written. */
  uploadsDir: string;
  /** Seeded accounts, by role. Passwords are fixtures, never real secrets. */
  accounts: Record<string, { account: string; password: string; id: number }>;
  /** Seeded ids the specs address by name instead of by guessing. */
  fixtures: Record<string, number>;
}
