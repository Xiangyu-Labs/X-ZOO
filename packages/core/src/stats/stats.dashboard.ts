import type { DashboardTile } from '@shop/contracts/system/schemas';
import type { Ctx } from '../kernel/context';
import { todayFigures } from './stats.service';

/**
 * What 统计 contributes to the admin home page.
 *
 * Three tiles, each against yesterday, and each a link to the page that
 * explains it and computes it the same way — a tile with nowhere to go, or with
 * a definition of its own, is a fourth number to argue about.
 *
 * Registered from `stats/index.ts` through `registerDashboardContributor`, so
 * a shop that has not imported this domain simply has no statistics tiles
 * rather than three zeros. The whole contributor runs behind the header's
 * three-second budget: if these aggregates are slow on a big shop, the header
 * degrades to the other domains' tiles and says so.
 *
 * `stats:trade:read` guards all three: whoever may not see the revenue page
 * does not learn today's revenue from the home page instead. 新增用户 is under
 * the same atom rather than `stats:user:read` because it ships in the same
 * call — splitting it would mean two round trips for one row of cards.
 */
export const statsDashboardContributor: {
  key: string;
  permission: string;
  order: number;
  tiles(ctx: Ctx): Promise<DashboardTile[]>;
} = {
  key: 'stats',
  permission: 'stats:trade:read',
  order: 100,
  async tiles(ctx) {
    const today = await todayFigures(ctx);
    return [
      {
        key: 'stats.revenue',
        label: '今日营业额',
        value: today.revenue,
        format: 'money',
        href: '/admin/stats/trade',
        deltaFromYesterday: round(today.revenue - today.previous.revenue),
      },
      {
        key: 'stats.paidOrders',
        label: '今日支付订单',
        value: today.paidOrderCount,
        format: 'count',
        href: '/admin/stats/orders',
        deltaFromYesterday: today.paidOrderCount - today.previous.paidOrderCount,
      },
      {
        key: 'stats.newUsers',
        label: '今日新增用户',
        value: today.newUsers,
        format: 'count',
        href: '/admin/stats/users',
        deltaFromYesterday: today.newUsers - today.previous.newUsers,
      },
    ];
  },
};

const round = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100 + 0;
