'use client';

import { statsProductExport, statsProducts } from '@shop/contracts/stats/stats.admin.contract';

import { useRouteQuery } from '@/admin/api/hooks';
import {
  ProductRankingTable,
  StatsExportButton,
  StatsPageFrame,
  useStatsRange,
} from '@/admin/stats';

/**
 * 商品统计 — the funnel (浏览 → 加购 → 下单 → 支付) and the ranking.
 *
 * 加购件数 counts `cart` product events, written in the same transaction as
 * the cart row. `cart_items` is not a substitute, because the row is deleted
 * when the order is placed.
 */
export function ProductStatsPage() {
  const range = useStatsRange();
  const { data, isPending } = useRouteQuery(statsProducts, { query: range.query });

  return (
    <StatsPageFrame
      subTitle="浏览、收藏与加购来自商品行为事件，下单与支付来自订单明细"
      range={range}
      data={data}
      loading={isPending}
      metricColumns={4}
      chartTitle="商品趋势"
      actions={
        <StatsExportButton
          route={statsProductExport}
          query={range.query}
          permission="stats:product:export"
          label="导出商品统计"
        />
      }
    >
      <ProductRankingTable query={range.query} />
    </StatsPageFrame>
  );
}
