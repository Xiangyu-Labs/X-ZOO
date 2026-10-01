'use client';

import { Card, Empty, Skeleton, theme } from 'antd';
import { useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { StatsChart as StatsChartData, StatsFormat } from '@shop/contracts/stats/schemas';

import { formatAxis, formatFigure } from './format';

/**
 * The chart every statistics page draws.
 *
 * `StatsChart` is deliberately close to what a chart library wants — bucket
 * labels, then one `values` array per series, all the same length — so there
 * is no reshaping here beyond a transpose, and no chance of a series and its
 * labels drifting apart.
 *
 * Two y-axes at most: one per *format*. A 营业额 in tens of thousands and a
 * 订单数 in dozens on one axis makes the order count a flat line at zero, which
 * is how a chart ends up nobody reads.
 */

/** After the theme's own primary, success and warning: the rest of antd's preset hues. */
const MORE_COLOURS = ['#eb2f96', '#13c2c2', '#722ed1'];

export function StatsChart({
  chart,
  loading,
  title,
  height = 320,
  extra,
}: {
  chart: StatsChartData | undefined;
  loading?: boolean;
  title?: string;
  height?: number;
  extra?: React.ReactNode;
}) {
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  // Grid, ticks and tooltip in the theme's colours: recharts' defaults are a
  // white tooltip and grey-on-white ticks, unreadable in dark mode.
  const { token } = theme.useToken();
  const palette = [token.colorPrimary, token.colorSuccess, token.colorWarning, ...MORE_COLOURS];
  const tick = { fontSize: 12, fill: token.colorTextSecondary };

  const rows = useMemo(() => {
    if (!chart) return [];
    return chart.buckets.map((bucket, index) => {
      const row: Record<string, string | number> = { bucket };
      for (const series of chart.series) row[series.name] = series.values[index] ?? 0;
      return row;
    });
  }, [chart]);

  // The axis a series hangs off is its format; at most two are drawn.
  const axes: StatsFormat[] = useMemo(() => {
    const seen: StatsFormat[] = [];
    for (const series of chart?.series ?? []) {
      if (!seen.includes(series.format)) seen.push(series.format);
    }
    return seen.slice(0, 2);
  }, [chart]);

  const body = () => {
    if (loading && !chart) return <Skeleton active paragraph={{ rows: 6 }} title={false} />;
    if (!chart || chart.series.length === 0) return <Empty description="暂无数据" />;
    // A window with no orders draws flat lines along the axis; say so instead.
    if (chart.series.every((series) => series.values.every((value) => value === 0))) {
      return <Empty description="该时间段内暂无数据" />;
    }

    return (
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            vertical={false}
            stroke={token.colorBorderSecondary}
          />
          <XAxis dataKey="bucket" tick={tick} stroke={token.colorBorder} minTickGap={16} />
          {axes.map((format, index) => (
            <YAxis
              key={format}
              yAxisId={format}
              orientation={index === 0 ? 'left' : 'right'}
              tick={tick}
              stroke={token.colorBorder}
              width={64}
              tickFormatter={(value: number) => formatAxis(value, format)}
            />
          ))}
          <Tooltip
            contentStyle={{
              background: token.colorBgElevated,
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadius,
              color: token.colorText,
            }}
            labelStyle={{ color: token.colorText }}
            cursor={{ fill: token.colorFillSecondary }}
            formatter={(value, name) => [
              formatFigure(Number(value), formatOf(chart, String(name))),
              name,
            ]}
          />
          <Legend
            onClick={(entry) => {
              const name = String(entry.dataKey ?? entry.value);
              setHidden((prev) => ({ ...prev, [name]: !prev[name] }));
            }}
          />
          {chart.series.map((series, index) => {
            const colour = palette[index % palette.length]!;
            const axis = axes.includes(series.format) ? series.format : axes[0]!;
            const common = {
              key: series.name,
              yAxisId: axis,
              dataKey: series.name,
              name: series.name,
              hide: hidden[series.name] === true,
            };
            return series.shape === 'bar' ? (
              <Bar {...common} fill={colour} maxBarSize={36} />
            ) : (
              <Line {...common} type="monotone" stroke={colour} strokeWidth={2} dot={false} />
            );
          })}
        </ComposedChart>
      </ResponsiveContainer>
    );
  };

  return (
    <Card size="small" title={title} extra={extra}>
      {body()}
    </Card>
  );
}

function formatOf(chart: StatsChartData, name: string): StatsFormat {
  return chart.series.find((series) => series.name === name)?.format ?? 'count';
}
