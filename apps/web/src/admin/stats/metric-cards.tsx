'use client';

import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { Card, Col, Row, Skeleton, Tooltip, Typography } from 'antd';
import type { StatsFormat, StatsMetric } from '@shop/contracts/stats/schemas';

import { deltaPercent, formatFigure } from './format';

/**
 * The headline figures of a statistics page.
 *
 * Every tile carries 环比 — the same figure over the window immediately before
 * this one — because a number without a comparison is not information. The
 * server decides when a comparison is meaningless (a running total like
 * 累计用户) by sending `previous: null`, and the tile then shows nothing rather
 * than a 0% that looks like "flat".
 *
 * A tile that also carries `yearAgo` (销售看板) adds 同比 under 环比, read
 * the same way.
 */
export type HeadlineMetric = StatsMetric & { yearAgo?: number | null };

export function MetricCards({
  metrics,
  loading,
  columns = 4,
}: {
  metrics: HeadlineMetric[] | undefined;
  loading?: boolean;
  columns?: 3 | 4 | 5 | 6;
}) {
  // Two a row until a whole row fits: four figures never wrap as three and one.
  const span = {
    xs: 24,
    sm: 12,
    ...(columns === 3 ? { md: 8 } : {}),
    lg: Math.floor(24 / columns),
  };

  if (loading && !metrics) {
    return (
      <Row gutter={[16, 16]}>
        {Array.from({ length: columns }, (_, index) => (
          <Col key={index} {...span}>
            <Card size="small">
              <Skeleton active paragraph={{ rows: 1 }} title={false} />
            </Card>
          </Col>
        ))}
      </Row>
    );
  }

  return (
    <Row gutter={[16, 16]}>
      {(metrics ?? []).map((metric) => (
        <Col key={metric.key} {...span}>
          <Card size="small">
            <Typography.Text type="secondary">{metric.label}</Typography.Text>
            <div style={{ fontSize: 24, lineHeight: '32px', fontVariantNumeric: 'tabular-nums' }}>
              {formatFigure(metric.value, metric.format)}
            </div>
            <MetricDelta metric={metric} />
            {metric.yearAgo === undefined ? null : (
              <div>
                <Comparison
                  label="同比"
                  tooltip="去年同期"
                  value={metric.value}
                  against={metric.yearAgo}
                  format={metric.format}
                />
              </div>
            )}
          </Card>
        </Col>
      ))}
    </Row>
  );
}

function MetricDelta({ metric }: { metric: StatsMetric }) {
  if (metric.previous === null) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        —
      </Typography.Text>
    );
  }
  return (
    <Comparison
      label="环比"
      tooltip="上一周期"
      value={metric.value}
      against={metric.previous}
      format={metric.format}
    />
  );
}

/** `环比 ↑ 3.45%`, or `环比 —` when the figure compared against is 0 or absent. */
function Comparison({
  label,
  tooltip,
  value,
  against,
  format,
}: {
  label: string;
  tooltip: string;
  value: number;
  against: number | null;
  format: StatsFormat;
}) {
  const delta = deltaPercent(value, against);
  if (delta === null) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {label} —
      </Typography.Text>
    );
  }
  if (delta === 0) {
    return (
      <Tooltip title={`${tooltip} ${formatFigure(against ?? 0, format)}`}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {label} 持平
        </Typography.Text>
      </Tooltip>
    );
  }
  const up = delta > 0;
  return (
    <Tooltip title={`${tooltip} ${formatFigure(against ?? 0, format)}`}>
      <Typography.Text type={up ? 'success' : 'danger'} style={{ fontSize: 12 }}>
        {label} {up ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {Math.abs(delta).toFixed(2)}%
      </Typography.Text>
    </Tooltip>
  );
}
