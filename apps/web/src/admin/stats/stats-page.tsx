'use client';

import { Space, Typography } from 'antd';
import type { ReactNode } from 'react';
import type { StatsBreakdown, StatsChart as StatsChartData } from '@shop/contracts/stats/schemas';

import { formatInstant } from '@/admin/kit/instant';
import { PageContainer } from '@/admin/kit/page-container';

import { BreakdownCards } from './breakdown-card';
import { MetricCards, type HeadlineMetric } from './metric-cards';
import { StatsRangePicker } from './range-picker';
import { StatsChart } from './stats-chart';
import type { StatsRange } from './use-stats-range';

export interface StatsPageData {
  from: string;
  to: string;
  metrics: HeadlineMetric[];
  chart: StatsChartData;
  generatedAt: string;
  breakdowns?: StatsBreakdown[];
}

/**
 * The shape all four statistics pages share: a window picker, headline tiles,
 * one chart, then whatever that page adds.
 *
 * It exists so the four pages differ only in the route they read and the
 * extras they hang underneath — which is the point of the contracts being
 * four shapes of the same `statsPage` object. The figures, their labels and
 * their order all come from the server, so a page never decides what a number
 * means.
 */
export function StatsPageFrame({
  subTitle,
  range,
  data,
  loading,
  metricColumns,
  actions,
  children,
  chartTitle = '趋势',
}: {
  subTitle: string;
  range: StatsRange;
  data: StatsPageData | undefined;
  loading: boolean;
  metricColumns?: 3 | 4 | 5 | 6;
  actions?: ReactNode;
  children?: ReactNode;
  chartTitle?: string;
}) {
  return (
    <PageContainer
      subTitle={subTitle}
      extra={
        <Space wrap>
          <StatsRangePicker range={range} />
          {actions}
        </Space>
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <MetricCards
          metrics={data?.metrics}
          loading={loading}
          {...(metricColumns ? { columns: metricColumns } : {})}
        />
        <StatsChart chart={data?.chart} loading={loading} title={chartTitle} />
        <BreakdownCards breakdowns={data?.breakdowns} />
        {children}
        {data ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            统计区间 {formatInstant(data.from, 'date')} 至{' '}
            {formatInstant(new Date(new Date(data.to).getTime() - 1000).toISOString(), 'date')}（
            {data.chart.bucket === 'hour'
              ? '按小时'
              : data.chart.bucket === 'day'
                ? '按天'
                : '按月'}
            ），数据生成于 {formatInstant(data.generatedAt, 'minute')}，最多缓存 60 秒
          </Typography.Text>
        ) : null}
      </Space>
    </PageContainer>
  );
}
