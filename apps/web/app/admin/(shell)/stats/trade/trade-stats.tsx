'use client';

import { statsTrade, statsTradeExport } from '@shop/contracts/stats/stats.admin.contract';

import { useRouteQuery } from '@/admin/api/hooks';
import { StatsExportButton, StatsPageFrame, useStatsRange } from '@/admin/stats';

/**
 * 交易统计 — 营业额, 商品支付金额, 运费, 退款, 客单价.
 *
 * 营业额 is 支付金额 minus the refunds that *succeeded* in the same bucket, not
 * minus the refunds belonging to orders paid in it: a day's figure then never
 * changes retroactively, and last month's chart reads the same next month. The
 * full definition of every figure on this page is in
 * `packages/core/src/stats/DEFINITIONS.md`.
 */
export function TradeStatsPage() {
  const range = useStatsRange();
  const { data, isPending } = useRouteQuery(statsTrade, { query: range.query });

  return (
    <StatsPageFrame
      subTitle="营业额按退款实际发生的时间扣减，历史数字不会回头改变"
      range={range}
      data={data}
      loading={isPending}
      metricColumns={5}
      chartTitle="交易趋势"
      actions={
        <StatsExportButton
          route={statsTradeExport}
          query={range.query}
          permission="stats:trade:export"
        />
      }
    />
  );
}
