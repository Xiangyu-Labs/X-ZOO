import type { CityProvince, CityTree } from '@shop/contracts/shipping/schemas';
import type { Ctx } from '../kernel/context';
import { toId } from '../kernel/ids';
import * as repo from './shipping.repo';

/**
 * The administrative-division tree.
 *
 * Read-only on both surfaces. `cities` is seed data the whole shop keys on:
 * freight regions point at division ids and every delivery address snapshots
 * one, so a division renamed or deleted at runtime silently re-prices orders.
 * There are no writes, and so no cache-bust route either: a cache-bust is only
 * needed where writes exist.
 *
 * Caching: the flat rows are fetched once per process and re-used while a cheap
 * fingerprint (row count + max id) still matches, so an unlucky container that
 * starts mid-reseed corrects itself on the next request instead of serving a
 * stale tree forever.
 */

interface CachedTree {
  version: string;
  items: CityProvince[];
}

let cached: CachedTree | null = null;

/** Tests reseed the table between cases; they call this so the next read rebuilds. */
export function resetCityTreeCache(): void {
  cached = null;
}

/** `setHeader` is present when the call came through `handle()`, absent in jobs and tests. */
export type ReadCtx = Ctx & { setHeader?: (name: string, value: string) => void };

export async function cityTree(ctx: ReadCtx): Promise<CityTree> {
  const fingerprint = await repo.cityFingerprint(ctx.db);
  const version = `cities-${fingerprint.count}-${fingerprint.maxId}`;
  if (cached === null || cached.version !== version) {
    cached = { version, items: buildTree(await repo.listCities(ctx.db)) };
  }
  // The body is immutable for as long as `version` holds, so it is worth a
  // strong-ish cache: a weak ETag for revalidation and a day of browser cache.
  // There is no 304 short-circuit — `Ctx` exposes no request headers — but the
  // ETag still lets a CDN or a service worker do the comparison.
  ctx.setHeader?.('ETag', `W/"${version}"`);
  ctx.setHeader?.('Cache-Control', 'public, max-age=86400');
  return { items: cached.items, version: cached.version };
}

/**
 * Flat rows → three levels.
 *
 * Rows arrive ordered by level, so a parent is always placed before its
 * children and one pass suffices. Anything whose parent is missing or whose
 * level is deeper than a district is dropped rather than re-parented: the
 * contract's shape is exactly three levels and a fourth would not survive the
 * response parse anyway.
 */
type CityCity = CityProvince['children'][number];
type CityDistrict = CityCity['children'][number];

function buildTree(rows: repo.CityNode[]): CityProvince[] {
  const provinces: CityProvince[] = [];
  const provinceById = new Map<number, CityProvince>();
  const cityById = new Map<number, CityCity>();

  for (const row of rows) {
    if (row.level === 0) {
      const province: CityProvince = { id: toId(row.id), name: row.name, level: 0, children: [] };
      provinces.push(province);
      provinceById.set(row.id, province);
      continue;
    }
    if (row.level === 1) {
      const parent = row.parentId === null ? undefined : provinceById.get(row.parentId);
      if (parent === undefined) continue;
      const city: CityCity = { id: toId(row.id), name: row.name, level: 1, children: [] };
      parent.children.push(city);
      cityById.set(row.id, city);
      continue;
    }
    if (row.level === 2) {
      const parent = row.parentId === null ? undefined : cityById.get(row.parentId);
      if (parent === undefined) continue;
      const district: CityDistrict = { id: toId(row.id), name: row.name, level: 2 };
      parent.children.push(district);
    }
  }
  return provinces;
}
