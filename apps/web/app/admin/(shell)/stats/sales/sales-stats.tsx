'use client';

import { Card, Col, Progress, Row, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  statsProductExport,
  statsSales,
  statsSalesExport,
} from '@shop/contracts/stats/stats.admin.contract';
import type { SalesCategoryRow } from '@shop/contracts/stats/schemas';

import { useRouteQuery } from '@/admin/api/hooks';
import { columnsWidth } from '@/admin/kit/table/crud-table';
import { Can } from '@/admin/session/can';
import {
  formatFigure,
  ProductRankingTable,
  StatsChart,
  StatsExportButton,
  StatsPageFrame,
  useStatsRange,
} from '@/admin/stats';

/**
 * 销售看板 — the sales figures of 交易统计 and 订单统计 on one screen, each tile
 * with 同比 as well as 环比, plus 时段分布, 分类销售 and the best sellers.
 *
 * Nothing here is a figure of its own: the server computes the tiles with the
 * same queries as those two pages, so 营业额 here and on 交易统计 agree. The
 * three additions are defined in `packages/core/src/stats/DEFINITIONS.md`.
 *
 * The ranking reads `stats/products/ranking`, which answers to 商品统计's atom,
 * so it is shown only to an admin who may open 商品统计.
 */
export function SalesStatsPage() {
  const range = useStatsRange();
  const { data, isPending } = useRouteQuery(statsSales, { query: range.query });

  return (
    <StatsPageFrame
      subTitle="营业额、订单、客单价与退款，含环比和去年同期"
      range={range}
      data={data}
      loading={isPending}
      chartTitle="销售趋势"
      actions={
        <StatsExportButton
          route={statsSalesExport}
          query={range.query}
          permission="stats:sales:export"
          label="导出分类销售"
        />
      }
    >
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <StatsChart chart={data?.hourly} loading={isPending} title="时段分布（0–23 点）" />
        </Col>
        <Col xs={24} xl={12}>
          <CategorySalesTable rows={data?.categories} loading={isPending} />
        </Col>
      </Row>
      <Can permission="stats:product:read">
        <ProductRankingTable
          query={range.query}
          defaultSort="paidAmount"
          defaultLimit={10}
          title="商品销售排行"
          extra={
            <StatsExportButton
              route={statsProductExport}
              query={{ ...range.query, sortBy: 'paidAmount', limit: 100 }}
              permission="stats:product:export"
              label="导出商品排行"
            />
          }
        />
      </Can>
    </StatsPageFrame>
  );
}

const CATEGORY_COLUMNS: ColumnsType<SalesCategoryRow> = [
  { title: '分类', dataIndex: 'name', key: 'name' },
  {
    title: '支付金额',
    dataIndex: 'paidAmount',
    key: 'paidAmount',
    align: 'right',
    width: 120,
    render: (value: number) => formatFigure(value, 'money'),
  },
  {
    title: '支付件数',
    dataIndex: 'paidQuantity',
    key: 'paidQuantity',
    align: 'right',
    width: 90,
    render: (value: number) => formatFigure(value, 'count'),
  },
  {
    title: '支付订单数',
    dataIndex: 'orderCount',
    key: 'orderCount',
    align: 'right',
    width: 100,
    render: (value: number) => formatFigure(value, 'count'),
  },
  {
    title: '占比',
    dataIndex: 'percent',
    key: 'percent',
    width: 150,
    render: (percent: number) => (
      <Progress
        percent={Math.min(percent, 100)}
        size="small"
        format={() => formatFigure(percent, 'percent')}
      />
    ),
  },
];

function CategorySalesTable({
  rows,
  loading,
}: {
  rows: SalesCategoryRow[] | undefined;
  loading: boolean;
}) {
  return (
    <Card size="small" title="分类销售">
      <Table<SalesCategoryRow>
        size="small"
        rowKey={(row) => row.categoryId ?? 'none'}
        pagination={false}
        loading={loading && !rows}
        dataSource={rows ?? []}
        locale={{ emptyText: '暂无数据' }}
        // A half-width card: scroll rather than squeeze 分类 to nothing.
        scroll={{ x: columnsWidth(CATEGORY_COLUMNS), y: 260 }}
        columns={CATEGORY_COLUMNS}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        按商品当前所属的一级分类统计；一个商品属于多个一级分类时在每个分类各计一次，占比合计可能超过
        100%。
      </Typography.Text>
    </Card>
  );
}
