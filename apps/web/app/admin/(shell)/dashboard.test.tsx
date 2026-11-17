import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { dashboardHeaderExample, type DashboardHeader } from '@shop/contracts/system/schemas';
import { systemDashboardHeader } from '@shop/contracts/system/system.settings.contract';
import {
  statsOrders,
  statsProductRanking,
  statsTrade,
} from '@shop/contracts/stats/stats.admin.contract';
import {
  orderStatsExample,
  productRankingExample,
  tradeStatsExample,
} from '@shop/contracts/stats/schemas';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity } from '@/test/render';

import { DashboardPage } from './dashboard';

/**
 * 工作台.
 *
 * The thing worth asserting about the home page is that it *contributes*
 * nothing: the tiles come from `/admin-api/dashboard/header`, which is already
 * permission-filtered server-side, and each block below only asks for the
 * route its atom opens. A home page that computed its own figures would end up
 * showing three different numbers for one day.
 */

function stubApi(header: DashboardHeader = dashboardHeaderExample): StubCall[] {
  return stubRoutes([
    on(systemDashboardHeader, header),
    on(statsProductRanking, productRankingExample),
    on(statsTrade, tradeStatsExample),
    on(statsOrders, orderStatsExample),
  ]);
}

const tileOf = (key: string) => {
  const tile = dashboardHeaderExample.tiles.find((entry) => entry.key === key);
  if (!tile) throw new Error(`no example tile ${key}`);
  return tile;
};

const identityWith = (permissions: string[]) => ({ ...testIdentity, permissions });

const ALL = ['system:dashboard:read', 'stats:trade:read', 'stats:order:read', 'stats:product:read'];

afterEach(() => {
  resetApiConfig();
});

describe('工作台', () => {
  it('renders the contributed tiles rather than figures of its own', async () => {
    const calls = stubApi();
    renderAdmin(<DashboardPage />, { identity: identityWith(ALL) });

    expect(await screen.findByText('管理员')).toBeInTheDocument();
    expect(screen.getByText('素材数量')).toBeInTheDocument();
    // 1280 attachments, grouped — and the tile's own href, not a page constant.
    expect(screen.getByText('1,280')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /素材数量/ })).toHaveAttribute(
      'href',
      '/admin/storage/attachments',
    );
    expect(calls.some((call) => call.url.includes('/admin-api/dashboard/header'))).toBe(true);
  });

  it('OPS-020 — shows 「异常待处理」 in the danger colour while there is work, linking to it', async () => {
    stubApi({
      ...dashboardHeaderExample,
      tiles: [
        {
          key: 'system.attention',
          label: '异常待处理',
          value: 3,
          format: 'count',
          href: '/admin/trade/effects',
          deltaFromYesterday: null,
          attention: true,
        },
        // The example's own 「异常待处理」 left out: this one has no per-source links.
        ...dashboardHeaderExample.tiles.filter((tile) => !tile.attention),
      ],
    });
    renderAdmin(<DashboardPage />, { identity: identityWith(ALL) });

    const figure = await screen.findByText('3');
    expect(figure.closest('.ant-typography-danger')).not.toBeNull();
    expect(screen.getByText('点击查看并处理')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /异常待处理/ })).toHaveAttribute(
      'href',
      '/admin/trade/effects',
    );
  });

  it('links each source of 「异常待处理」 on its own, and the whole tile elsewhere', async () => {
    stubApi();
    renderAdmin(<DashboardPage />, { identity: identityWith(ALL) });

    expect(await screen.findByRole('link', { name: '异常支付 2' })).toHaveAttribute(
      'href',
      '/admin/trade/payment-exceptions',
    );
    expect(screen.getByRole('link', { name: '失败的后台任务 1' })).toHaveAttribute(
      'href',
      '/admin/system/failed-jobs',
    );
    // An ordinary tile is one link, card and all.
    expect(screen.getByRole('link', { name: /管理员/ }).querySelector('.ant-card')).not.toBeNull();
  });

  it('says 持平 for a figure that did not move since yesterday', async () => {
    stubApi({
      ...dashboardHeaderExample,
      tiles: [{ ...tileOf('stats.paidOrders'), deltaFromYesterday: 0 }],
    });
    renderAdmin(<DashboardPage />, { identity: identityWith(ALL) });
    expect(await screen.findByText('较昨日持平')).toBeInTheDocument();
  });

  it('shows the last 30 days: net revenue, refund rate and a sales ranking', async () => {
    const calls = stubApi();
    renderAdmin(<DashboardPage />, { identity: identityWith(ALL) });

    expect(await screen.findByText('经营概览（最近30天）')).toBeInTheDocument();
    // Picked from the stats pages' own metrics, not recomputed here (营业额 is
    // also a 今日数据 card).
    expect(await screen.findAllByText('营业额')).toHaveLength(2);
    expect(await screen.findByText('退款率')).toBeInTheDocument();
    expect(screen.getByText('2.83%')).toBeInTheDocument();
    await waitFor(() => {
      const ranking = calls.find((call) => call.url.includes('/stats/products/ranking'));
      expect(ranking?.url).toContain('sortBy=paidQuantity');
    });
  });

  it('asks only for the blocks the admin may see', async () => {
    const calls = stubApi();
    renderAdmin(<DashboardPage />, {
      identity: identityWith(['system:dashboard:read', 'stats:trade:read']),
    });

    await screen.findByText('管理员');
    await waitFor(() => expect(calls.some((call) => call.url.includes('/stats/trade'))).toBe(true));
    expect(calls.some((call) => call.url.includes('/stats/orders'))).toBe(false);
    expect(calls.some((call) => call.url.includes('/stats/products/ranking'))).toBe(false);
  });

  it('leaves out the tiles a role may not read instead of a skeleton that never resolves', async () => {
    stubApi();
    const { container } = renderAdmin(<DashboardPage />, {
      identity: identityWith(['stats:trade:read']),
    });

    expect(await screen.findByText('营业额')).toBeInTheDocument();
    expect(container.querySelector('.ant-skeleton')).toBeNull();
  });

  it('shows what is missing instead of going down when a contributor fails', async () => {
    stubApi({ ...dashboardHeaderExample, degraded: ['storage'] });
    renderAdmin(<DashboardPage />, { identity: identityWith(ALL) });

    expect(await screen.findByText('部分指标暂时不可用')).toBeInTheDocument();
    // The contributor's key is for the logs; staff read Chinese only.
    expect(screen.queryByText(/storage/)).toBeNull();
    // The tiles that did come back are still on the page.
    expect(screen.getByText('管理员')).toBeInTheDocument();
  });

  it('#99 — 待办事项: each queue opens the order list on its tab, 库存预警 its page', async () => {
    stubApi();
    renderAdmin(<DashboardPage />, { identity: identityWith(ALL) });

    // Past the skeleton, which already carries the row's title.
    await screen.findByText('待付款');
    expect(screen.getByText('待办事项')).toBeInTheDocument();
    for (const [label, href] of [
      ['待付款', '/admin/orders?tab=unpaid'],
      ['待发货', '/admin/orders?tab=unshipped'],
      ['待售后', '/admin/orders?tab=refunding'],
      ['库存预警', '/admin/catalog/stock-warnings'],
    ] as const) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).toHaveAttribute('href', href);
    }
    // A queue has no 较昨日: it says what to do instead.
    expect(screen.getAllByText('点击去处理')).toHaveLength(4);
  });

  it('#99 — 今日数据: six cards against yesterday, each opening its statistics page', async () => {
    stubApi();
    renderAdmin(<DashboardPage />, { identity: identityWith(ALL) });

    await screen.findByText('加购人数');
    expect(screen.getByText('今日数据')).toBeInTheDocument();
    for (const [key, page] of [
      ['stats.revenue', 'trade'],
      ['stats.paidOrders', 'orders'],
      ['stats.refundOrders', 'orders'],
      ['stats.visitors', 'users'],
      ['stats.pageViews', 'users'],
      ['stats.cartUsers', 'users'],
    ] as const) {
      const tile = tileOf(key);
      expect(tile.href).toMatch(new RegExp(`^/admin/stats/${page}\\?from=`));
      // 订单量 and 退款订单数 open the same page, so look for the card by both.
      const link = screen
        .getAllByRole('link')
        .find(
          (element) =>
            element.getAttribute('href') === tile.href && element.textContent?.includes(tile.label),
        );
      expect(link, key).toBeDefined();
    }
    expect(screen.getByText('¥5,320.50')).toBeInTheDocument();
  });

  it('#99 — colours a rise in 退款订单数 as bad news', async () => {
    stubApi({
      ...dashboardHeaderExample,
      tiles: [tileOf('stats.refundOrders'), tileOf('stats.paidOrders')],
    });
    renderAdmin(<DashboardPage />, { identity: identityWith(ALL) });

    const refund = await screen.findByRole('link', { name: /退款订单数/ });
    expect(refund.querySelector('.ant-typography-danger')).not.toBeNull();
    const orders = screen.getByRole('link', { name: /订单量/ });
    expect(orders.querySelector('.ant-typography-success')).not.toBeNull();
  });

  it('#99 — leaves out a row with no card the admin may see', async () => {
    stubApi({
      ...dashboardHeaderExample,
      tiles: dashboardHeaderExample.tiles.filter((tile) => tile.section !== 'today'),
    });
    renderAdmin(<DashboardPage />, { identity: identityWith(ALL) });

    await screen.findByText('待付款');
    expect(screen.queryByText('今日数据')).toBeNull();
  });
});
