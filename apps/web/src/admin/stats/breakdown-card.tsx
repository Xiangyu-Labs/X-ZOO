'use client';

import { Card, Col, Progress, Row, Table, Typography } from 'antd';
import type { StatsBreakdown } from '@shop/contracts/stats/schemas';

import { formatFigure } from './format';

/**
 * 来源 / 类型 breakdowns, as a table with a share bar rather than a pie.
 *
 * A pie of six platforms is harder to read than six rows, cannot be copied,
 * and needs a legend to say what the slices are. The bar carries the same
 * "share of the whole" the pie was for.
 */
export function BreakdownCards({ breakdowns }: { breakdowns: StatsBreakdown[] | undefined }) {
  if (!breakdowns?.length) return null;

  return (
    <Row gutter={[16, 16]}>
      {breakdowns.map((breakdown) => (
        <Col key={breakdown.key} xs={24} lg={12}>
          <Card size="small" title={breakdown.label}>
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={breakdown.rows}
              locale={{ emptyText: '暂无数据' }}
              columns={[
                { title: '分类', dataIndex: 'label', key: 'label' },
                {
                  title: '数值',
                  dataIndex: 'value',
                  key: 'value',
                  align: 'right' as const,
                  width: 140,
                  render: (value: number) => formatFigure(value, breakdown.format),
                },
                {
                  title: '占比',
                  dataIndex: 'percent',
                  key: 'percent',
                  width: 180,
                  render: (percent: number) => (
                    <Progress
                      percent={percent}
                      size="small"
                      format={(value) => `${(value ?? 0).toFixed(2)}%`}
                    />
                  ),
                },
              ]}
            />
            {breakdown.rows.length === 0 ? null : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                占比以本区间内的合计为分母
              </Typography.Text>
            )}
          </Card>
        </Col>
      ))}
    </Row>
  );
}
