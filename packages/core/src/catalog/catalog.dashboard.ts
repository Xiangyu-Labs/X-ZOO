import type { DashboardTile } from '@shop/contracts/system/schemas';
import type { Ctx } from '../kernel/context';
import { countTile, type DashboardContributor } from '../system';
import { adminStockWarnings } from './catalog.service';

/**
 * What the catalog contributes to 工作台: the 库存预警 待办 card.
 *
 * The count is the total of the 库存预警 page with no filter — the same query,
 * at the same `catalog.stockWarningThreshold`, asked for one row — so the card
 * and the page it opens agree: SKUs (not products) at or below the threshold,
 * visible, on products that are not drafts.
 *
 * Gated on `catalog:product:read`, the atom of the page and of its read route.
 */
export const catalogDashboardContributor: DashboardContributor = {
  key: 'catalog',
  permission: 'catalog:product:read',
  order: 40,
  async tiles(ctx: Ctx): Promise<DashboardTile[]> {
    const { total } = await adminStockWarnings(ctx, { page: 1, pageSize: 1 });
    return [
      {
        ...countTile({
          key: 'catalog.stockWarnings',
          label: '库存预警',
          value: total,
          href: '/admin/catalog/stock-warnings',
        }),
        section: 'todo',
      },
    ];
  },
};
