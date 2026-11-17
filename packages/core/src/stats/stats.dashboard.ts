import type { DashboardTile } from '@shop/contracts/system/schemas';
import { hasPermission } from '../auth/rbac';
import type { Ctx } from '../kernel/context';
import { todayFigures } from './stats.service';

/**
 * What 统计 contributes to the admin home page: the 今日数据 row.
 *
 * Six cards, each today against yesterday, and each a link to the page that
 * explains it and computes it the same way — opened on 今天, so the number on
 * the card is the number at the top of the page. A tile with nowhere to go, or
 * with a definition of its own, is a seventh number to argue about.
 *
 * | Card       | Same figure as        | Atom               |
 * | ---------- | --------------------- | ------------------ |
 * | 营业额     | 交易统计 · 营业额     | `stats:trade:read` |
 * | 订单量     | 订单统计 · 订单量     | `stats:order:read` |
 * | 退款订单数 | 订单统计 · 退款订单数 | `stats:order:read` |
 * | 访客数     | 用户统计 · 访客数     | `stats:user:read`  |
 * | 浏览量     | 用户统计 · 浏览量     | `stats:user:read`  |
 * | 加购人数   | 用户统计 · 加购人数   | `stats:user:read`  |
 *
 * Each card is gated on the atom of the page it opens, which is also the atom
 * of that page's read route: whoever may not open 交易统计 does not learn
 * today's revenue from the home page instead, and nobody gets a card whose
 * link answers 无权限. So the contributor itself has no single atom; it filters
 * per card, and skips the queries of a half nobody here may see.
 *
 * Registered from `stats/index.ts` through `registerDashboardContributor`, so
 * a shop that has not imported this domain simply has no statistics cards
 * rather than six zeros. The whole contributor runs behind the header's
 * three-second budget: if these aggregates are slow on a big shop, the header
 * degrades to the other domains' tiles and says so.
 */
export const statsDashboardContributor: {
  key: string;
  order: number;
  tiles(ctx: Ctx): Promise<DashboardTile[]>;
} = {
  key: 'stats',
  order: 100,
  async tiles(ctx) {
    const can = {
      trade: hasPermission(ctx.actor, 'stats:trade:read'),
      orders: hasPermission(ctx.actor, 'stats:order:read'),
      users: hasPermission(ctx.actor, 'stats:user:read'),
    };
    if (!can.trade && !can.orders && !can.users) return [];

    const today = await todayFigures(ctx, { trade: can.trade || can.orders, users: can.users });
    const href = (page: 'trade' | 'orders' | 'users'): string => {
      // One whole Shanghai day on both ends: the page's picker reads 今天, and
      // the server resolves the same window this card was computed over.
      const day = today.day.toISOString();
      return `/admin/stats/${page}?from=${encodeURIComponent(day)}&to=${encodeURIComponent(day)}`;
    };

    const tiles: DashboardTile[] = [];
    const trade = today.trade;
    if (trade && can.trade) {
      tiles.push(
        tile(
          'stats.revenue',
          '营业额',
          'money',
          href('trade'),
          trade.current.revenue,
          round(trade.current.revenue - trade.previous.revenue),
        ),
      );
    }
    if (trade && can.orders) {
      tiles.push(
        tile(
          'stats.paidOrders',
          '订单量',
          'count',
          href('orders'),
          trade.current.paidOrderCount,
          trade.current.paidOrderCount - trade.previous.paidOrderCount,
        ),
        {
          ...tile(
            'stats.refundOrders',
            '退款订单数',
            'count',
            href('orders'),
            trade.current.refundOrderCount,
            trade.current.refundOrderCount - trade.previous.refundOrderCount,
          ),
          lowerIsBetter: true,
        },
      );
    }
    const users = today.users;
    if (users) {
      tiles.push(
        tile(
          'stats.visitors',
          '访客数',
          'count',
          href('users'),
          users.current.visitors,
          users.current.visitors - users.previous.visitors,
        ),
        tile(
          'stats.pageViews',
          '浏览量',
          'count',
          href('users'),
          users.current.pageViews,
          users.current.pageViews - users.previous.pageViews,
        ),
        tile(
          'stats.cartUsers',
          '加购人数',
          'count',
          href('users'),
          users.current.cartUsers,
          users.current.cartUsers - users.previous.cartUsers,
        ),
      );
    }
    return tiles;
  },
};

function tile(
  key: string,
  label: string,
  format: 'count' | 'money',
  href: string,
  value: number,
  deltaFromYesterday: number,
): DashboardTile {
  return { key, label, value, format, href, deltaFromYesterday, section: 'today' };
}

const round = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100 + 0;
