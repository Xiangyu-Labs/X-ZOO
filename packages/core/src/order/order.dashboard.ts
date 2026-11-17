import type { AdminOrderTabKey } from '@shop/contracts/order/order.fulfil.schemas';
import type { DashboardTile } from '@shop/contracts/system/schemas';
import type { Ctx } from '../kernel/context';
import { countTile, type DashboardContributor } from '../system';
import { countInTab } from './order.console.service';

/** The 待办 cards, in the order the home page shows them. */
const CARDS: { key: string; label: string; tab: AdminOrderTabKey }[] = [
  { key: 'order.unpaid', label: '待付款', tab: 'unpaid' },
  { key: 'order.unshipped', label: '待发货', tab: 'unshipped' },
  { key: 'order.refunding', label: '待售后', tab: 'refunding' },
];

/**
 * What the order domain contributes to 工作台: three 待办 cards.
 *
 * Each is `count(*)` of exactly the filter its 订单列表 tab applies
 * (`adminOrderTabs`, shared with the list), and links to that tab — so the
 * number on the card is the list's total when it opens. Whole shop, no date
 * range: they are a work queue, like the counters above the list.
 *
 * Gated on `order:order:read`, the atom of the list they open: an admin who
 * may not open 订单列表 gets no cards rather than links that answer 无权限.
 */
export const orderDashboardContributor: DashboardContributor = {
  key: 'order',
  permission: 'order:order:read',
  order: 10,
  async tiles(ctx: Ctx): Promise<DashboardTile[]> {
    const counts = await Promise.all(CARDS.map((card) => countInTab(ctx, card.tab)));
    return CARDS.map((card, index) => ({
      ...countTile({
        key: card.key,
        label: card.label,
        value: counts[index] ?? 0,
        href: `/admin/orders?tab=${card.tab}`,
      }),
      section: 'todo' as const,
    }));
  },
};
