import type { DashboardHeader, DashboardTile } from '@shop/contracts/system/schemas';
import type { Ctx } from '../kernel/context';
import { hasPermission } from '../auth/rbac';

/**
 * The admin home page's header tiles.
 *
 * The old `home/header` endpoint hard-coded six numbers from four different
 * modules into one controller, so adding a figure meant editing a file that
 * belonged to nobody, and one slow query made the whole dashboard 500.
 *
 * Here a domain *contributes*:
 *
 * ```ts
 * registerDashboardContributor({
 *   key: 'order',
 *   permission: 'order:order:read',
 *   async tiles(ctx) { … },
 * });
 * ```
 *
 * Three properties fall out of that, and they are why this registry exists:
 *
 * 1. **A contributor that throws degrades one tile, not the page.** Its key
 *    lands in `degraded` and the rest still render. A dashboard is the first
 *    screen an operator sees during an incident; it must not be the second
 *    casualty.
 * 2. **A contributor that is not loaded contributes nothing** — no zero, no
 *    placeholder. A deployment without the stats contributor shows what exists
 *    rather than inventing numbers.
 * 3. **Tiles are permission-filtered.** Somebody who cannot open the orders
 *    screen does not learn today's revenue from the home page.
 */

export interface DashboardContributor {
  /** Stable id, usually the domain name. Also what shows up in `degraded`. */
  key: string;
  /** Atom the caller needs for these tiles. Omit for "everybody". */
  permission?: string;
  /** Lower first. Ties fall back to registration order. */
  order?: number;
  tiles(ctx: Ctx): Promise<DashboardTile[]>;
}

const contributors = new Map<string, DashboardContributor & { seq: number }>();
let seq = 0;

export function registerDashboardContributor(contributor: DashboardContributor): void {
  contributors.set(contributor.key, { ...contributor, seq: (seq += 1) });
}

/** Test helper. Never call this from app code. */
export function resetDashboardContributors(): void {
  contributors.clear();
  seq = 0;
}

export function dashboardContributorKeys(): string[] {
  return [...contributors.keys()].sort();
}

/** How long one contributor may take before the page gives up on it. */
const CONTRIBUTOR_TIMEOUT_MS = 3000;

export async function dashboardHeader(ctx: Ctx): Promise<DashboardHeader> {
  const eligible = [...contributors.values()]
    .filter((c) => !c.permission || hasPermission(ctx.actor, c.permission))
    .sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.seq - b.seq);

  const tiles: DashboardTile[] = [];
  const degraded: string[] = [];

  // In parallel: six sequential dashboard queries take seconds to paint.
  const settled = await Promise.all(
    eligible.map(async (contributor) => {
      try {
        return { key: contributor.key, tiles: await withTimeout(contributor.tiles(ctx)) };
      } catch (error) {
        ctx.logger.warn({ err: error, contributor: contributor.key }, 'dashboard tile failed');
        return { key: contributor.key, tiles: null };
      }
    }),
  );

  for (const result of settled) {
    if (result.tiles === null) degraded.push(result.key);
    else tiles.push(...result.tiles);
  }

  return { tiles, degraded, generatedAt: ctx.clock.now().toISOString() };
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('dashboard: contributor timed out')),
        CONTRIBUTOR_TIMEOUT_MS,
      );
      // Do not hold the process open for a tile.
      timer.unref?.();
    }),
  ]);
}

export function countTile(args: {
  key: string;
  label: string;
  value: number;
  href?: string | null;
  deltaFromYesterday?: number | null;
}): DashboardTile {
  return {
    key: args.key,
    label: args.label,
    value: args.value,
    format: 'count',
    href: args.href ?? null,
    deltaFromYesterday: args.deltaFromYesterday ?? null,
  };
}
