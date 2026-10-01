'use client';

import { statsOrders } from '@shop/contracts/stats/stats.admin.contract';

import { useRouteQuery } from '@/admin/api/hooks';
import { StatsPageFrame, useStatsRange } from '@/admin/stats';

/**
 * 订单统计 — counts and their 来源 / 类型 breakdowns.
 *
 * The companion of 交易统计: this page counts orders, that one counts money.
 * They are separate because 下单量 and 营业额 answer to different times (下单
 * time and 支付 time) and putting them on one page invites reading a
 * conversion rate off two numbers that are not about the same orders.
 */
export function OrderStatsPage() {
  const range = useStatsRange();
  const { data, isPending } = useRouteQuery(statsOrders, { query: range.query });

  return (
    <StatsPageFrame
      subTitle="下单量按下单时间统计，支付量按支付时间统计"
      range={range}
      data={data}
      loading={isPending}
      metricColumns={4}
      chartTitle="订单趋势"
    />
  );
}
