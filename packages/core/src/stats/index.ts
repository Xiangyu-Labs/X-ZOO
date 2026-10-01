/**
 * `stats` — every operator figure, and the only domain allowed to read another
 * domain's tables.
 *
 * | Caller                                      | Entry point               |
 * | ------------------------------------------- | ------------------------- |
 * | `GET /admin-api/stats/users`                | `userStats`               |
 * | `GET /admin-api/stats/users/regions`        | `userRegions`             |
 * | `GET /admin-api/stats/products`             | `productStats`            |
 * | `GET /admin-api/stats/products/ranking`     | `productRanking`          |
 * | `GET /admin-api/stats/products/exports`     | `productExport`           |
 * | `GET /admin-api/stats/trade`                | `tradeStats`              |
 * | `GET /admin-api/stats/trade/exports`        | `tradeExport`             |
 * | `GET /admin-api/stats/orders`               | `orderStats`              |
 * | `GET /admin-api/stats/sales`                | `salesStats`              |
 * | `GET /admin-api/stats/sales/exports`        | `salesExport`             |
 * | `GET /admin-api/dashboard/header` (system)  | the dashboard contributor |
 *
 * **No job.** This domain writes no row, so it has no row to sweep: the
 * retention of `product_events` is the catalog domain's `catalog.pruneHistory`,
 * and `user_visits` is swept by its writer, the user domain's
 * `user.pruneVisits`, over the window this domain's `visitRetentionDays`
 * config sets. `stats.repo.ts` stays `select`-only, so that claim stays
 * checkable by reading one file.
 *
 * **Other domains do not call this one.** Nothing here is a dependency of any
 * business flow: a statistics page is downstream of everything and upstream of
 * nothing, which is exactly what makes reading other domains' tables tolerable
 * here and nowhere else. `stats.repo.ts` is not exported and never will be.
 *
 * Importing this file registers the three home-page tiles, and nothing else.
 * The permission atoms register themselves with `permissions.ts`, the config
 * group through `stats.config.ts`, both picked up by `pnpm gen`.
 */
import { registerDashboardContributor } from '../system';
import { statsDashboardContributor } from './stats.dashboard';

registerDashboardContributor(statsDashboardContributor);

export { statsPermissions } from './permissions';
export { statsConfig } from './stats.config';
export { clearStatsCache } from './stats.cache';
export { statsDashboardContributor } from './stats.dashboard';
export {
  orderStats,
  productExport,
  productRanking,
  productStats,
  salesExport,
  salesStats,
  todayFigures,
  tradeExport,
  tradeStats,
  userRegions,
  userStats,
  type TodayFigures,
} from './stats.service';
export {
  MAX_RANGE_DAYS,
  bucketFor,
  resolveRange,
  shanghaiDayLabel,
  type ResolvedRange,
} from './stats.range';
