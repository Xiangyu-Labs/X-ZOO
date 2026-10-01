import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  orderStatsExample,
  productRankingExample,
  productStatsExample,
  salesExportExample,
  salesStatsExample,
  statsExportExample,
  tradeStatsExample,
  userRegionStatsExample,
  userStatsExample,
} from '@shop/contracts/stats/schemas';
import {
  statsOrders,
  statsProductExport,
  statsProductRanking,
  statsProducts,
  statsSales,
  statsSalesExport,
  statsTrade,
  statsTradeExport,
  statsUserRegions,
  statsUsers,
} from '@shop/contracts/stats/stats.admin.contract';

import { resetApiConfig } from '@/admin/api/config';
import { on, stubRoutes, type StubCall } from '@/test/api';
import { renderAdmin, testIdentity } from '@/test/render';

import { OrderStatsPage } from './orders/order-stats';
import { ProductStatsPage } from './products/product-stats';
import { SalesStatsPage } from './sales/sales-stats';
import { TradeStatsPage } from './trade/trade-stats';
import { UserStatsPage } from './users/user-stats';

/**
 * The five statistics pages as component tests: no browser, no server, one
 * stub `fetch` answering with the *contract's own examples*.
 *
 * Using the examples rather than hand-written payloads is the point. They are
 * the same objects `pnpm --filter @shop/contracts check:examples` parses
 * against the response schemas, so a page that renders them is a page that
 * renders what the server is allowed to send — and a contract change that
 * breaks the page breaks this file.
 *
 * What is asserted is wiring: the right route with the range in the query, the
 * labels and figures coming from the server rather than from the page, the
 * export atom really hiding the button, and the export assembling a download
 * from the CSV-in-JSON envelope. The chart itself is not asserted —
 * recharts measures its container, and a zero-width container in happy-dom
 * renders nothing; `StatsChart`'s reshaping is covered where it is pure.
 */

function stubApi(): StubCall[] {
  return stubRoutes([
    on(statsUserRegions, userRegionStatsExample),
    on(statsUsers, userStatsExample),
    on(statsProductExport, statsExportExample),
    on(statsProductRanking, productRankingExample),
    on(statsProducts, productStatsExample),
    on(statsTradeExport, statsExportExample),
    on(statsTrade, tradeStatsExample),
    on(statsOrders, orderStatsExample),
    on(statsSalesExport, salesExportExample),
    on(statsSales, salesStatsExample),
  ]);
}

const identityWith = (permissions: string[]) => ({ ...testIdentity, permissions });

afterEach(() => {
  resetApiConfig();
});

// ---------------------------------------------------------------------------

describe('交易统计', () => {
  it('reads the trade route and shows the server’s own labels', async () => {
    const calls = stubApi();
    renderAdmin(<TradeStatsPage />, {
      identity: identityWith(['stats:trade:read', 'stats:trade:export']),
    });

    expect(await screen.findByText('营业额')).toBeInTheDocument();
    expect(screen.getByText('¥80,490.40')).toBeInTheDocument();
    expect(calls[0]?.url).toContain('/admin-api/stats/trade');
  });

  it('hides 导出 from an admin without the export atom', async () => {
    stubApi();
    renderAdmin(<TradeStatsPage />, { identity: identityWith(['stats:trade:read']) });

    await screen.findByText('营业额');
    expect(screen.queryByRole('button', { name: /导出/ })).not.toBeInTheDocument();
  });

  it('turns the CSV envelope into a download', async () => {
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:stub';
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    // happy-dom treats an anchor click as a navigation and reaches for the
    // real `URL` constructor, which the stub above has replaced.
    const saved: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download);
    });
    const calls = stubApi();

    renderAdmin(<TradeStatsPage />, {
      identity: identityWith(['stats:trade:read', 'stats:trade:export']),
    });
    await screen.findByText('营业额');
    await userEvent.click(screen.getByRole('button', { name: /导出/ }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/stats/trade/exports'))).toBe(true);
      expect(createObjectURL).toHaveBeenCalled();
    });
    expect(click).toHaveBeenCalled();
    // The server's CSV, byte for byte, under the server's filename; only the
    // BOM is added here, so Excel reads it as UTF-8.
    expect(saved).toEqual([statsExportExample.filename]);
    expect(await blobs[0]!.text()).toBe(`\uFEFF${statsExportExample.content}`);
    vi.unstubAllGlobals();
  });
});

describe('订单统计', () => {
  it('renders the 来源 breakdown the server sent, with its shares', async () => {
    stubApi();
    renderAdmin(<OrderStatsPage />, { identity: identityWith(['stats:order:read']) });

    expect(await screen.findByText('订单量')).toBeInTheDocument();
    expect(screen.getByText('订单来源')).toBeInTheDocument();
    expect(screen.getByText('小程序')).toBeInTheDocument();
  });
});

describe('用户统计', () => {
  it('asks for the regions separately, with the sort and limit it offers', async () => {
    const calls = stubApi();
    renderAdmin(<UserStatsPage />, { identity: identityWith(['stats:user:read']) });

    expect(await screen.findByText('新增用户')).toBeInTheDocument();
    await waitFor(() => {
      const regions = calls.find((call) => call.url.includes('/stats/users/regions'));
      expect(regions?.url).toContain('sortBy=totalUsers');
      expect(regions?.url).toContain('limit=10');
    });
    expect(await screen.findByText('广东')).toBeInTheDocument();
  });
  it('writes 平均停留时长 as a duration, not a count of milliseconds', async () => {
    stubApi();
    renderAdmin(<UserStatsPage />, { identity: identityWith(['stats:user:read']) });

    expect(await screen.findByText('平均停留时长')).toBeInTheDocument();
    expect(screen.getByText('1分05秒')).toBeInTheDocument();
  });
});

describe('销售看板', () => {
  it('shows each tile with 环比 and 同比, and the category split', async () => {
    const calls = stubApi();
    renderAdmin(<SalesStatsPage />, { identity: identityWith(['stats:sales:read']) });

    expect(await screen.findByText('营业额')).toBeInTheDocument();
    expect(screen.getByText('¥80,490.40')).toBeInTheDocument();
    expect(calls[0]?.url).toContain('/admin-api/stats/sales');
    // Seven tiles, each compared both ways.
    expect(screen.getAllByText(/^环比/)).toHaveLength(7);
    expect(screen.getAllByText(/^同比/)).toHaveLength(7);
    // 80,490.40 against 61,200.00 a year earlier.
    expect(screen.getAllByText(/^同比/)[0]).toHaveTextContent('31.52%');

    expect(screen.getByText('分类销售')).toBeInTheDocument();
    expect(screen.getByText('咖啡')).toBeInTheDocument();
    expect(screen.getByText('¥52,310.40')).toBeInTheDocument();
    expect(screen.getByText('63.55%')).toBeInTheDocument();
    expect(screen.getByText('订单来源')).toBeInTheDocument();
  });

  it('leaves the ranking out for an admin who may not open 商品统计', async () => {
    const calls = stubApi();
    renderAdmin(<SalesStatsPage />, { identity: identityWith(['stats:sales:read']) });

    await screen.findByText('营业额');
    expect(screen.queryByText('商品销售排行')).not.toBeInTheDocument();
    expect(calls.some((call) => call.url.includes('/stats/products/ranking'))).toBe(false);
    expect(screen.queryByRole('button', { name: /导出/ })).not.toBeInTheDocument();
  });

  it('shows the ranking and each export only with its own atom', async () => {
    const calls = stubApi();
    renderAdmin(<SalesStatsPage />, {
      identity: identityWith([
        'stats:sales:read',
        'stats:sales:export',
        'stats:product:read',
        'stats:product:export',
      ]),
    });

    expect(await screen.findByText('云南小粒咖啡豆 500g')).toBeInTheDocument();
    const ranking = calls.find((call) => call.url.includes('/stats/products/ranking'));
    expect(ranking?.url).toContain('sortBy=paidAmount');
    expect(ranking?.url).toContain('limit=10');
    expect(screen.getByRole('button', { name: /导出分类销售/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /导出商品排行/ })).toBeInTheDocument();
  });
});

describe('商品统计', () => {
  it('shows the ranking under the page, sorted in SQL', async () => {
    const calls = stubApi();
    renderAdmin(<ProductStatsPage />, {
      identity: identityWith(['stats:product:read', 'stats:product:export']),
    });

    expect(await screen.findByText('云南小粒咖啡豆 500g')).toBeInTheDocument();
    const ranking = calls.find((call) => call.url.includes('/stats/products/ranking'));
    expect(ranking?.url).toContain('sortBy=paidAmount');
  });
});
