'use client';

import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { Alert, Card, Col, Row, Skeleton, Space, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import Link from 'next/link';
import { statsOrders, statsTrade } from '@shop/contracts/stats/stats.admin.contract';
import type { StatsMetric } from '@shop/contracts/stats/schemas';
import type { DashboardTile } from '@shop/contracts/system/schemas';
import { systemDashboardHeader } from '@shop/contracts/system/system.settings.contract';

import { useRouteQuery } from '@/admin/api/hooks';
import { PageContainer } from '@/admin/kit/page-container';
import { useMemoryUrlState } from '@/admin/kit/table/url-state';
import { useCan, useSession } from '@/admin/session/session-provider';
import {
  formatFigure,
  MetricCards,
  ProductRankingTable,
  StatsChart,
  StatsRangePicker,
  useStatsRange,
} from '@/admin/stats';

/**
 * 工作台.
 *
 * The tiles are **not** computed here. They come from
 * `GET /admin-api/dashboard/header`, which asks every registered
 * `DashboardContributor` — `system`, `storage` and `stats` — in
 * parallel and permission-filtered. That is why a tile can be *missing* rather
 * than zero: an admin who may not open 交易统计 does not learn today's revenue
 * from the home page instead, and a contributor that throws lands in
 * `degraded` instead of taking the page down.
 *
 * Everything below the tiles is the ordinary statistics surface, with a window
 * held in memory rather than in the URL: the home page is where an operator
 * lands, and it should not accumulate a query string. The window defaults to
 * the last 30 days, and the 经营概览 row picks its figures from the 交易 and
 * 订单 pages' own metrics — 营业额 is already net of refunds — so the home page
 * adds no definition of its own.
 */
export function DashboardPage() {
  const { identity } = useSession();
  const can = useCan();
  const urlState = useMemoryUrlState();
  const range = useStatsRange(urlState);

  const canHeader = can('system:dashboard:read');
  const canTrade = can('stats:trade:read');
  const canOrders = can('stats:order:read');

  // A disabled query stays `isPending` for ever, so "loading" is asked only
  // of the queries this admin may run: a role without 订单统计 must not
  // watch the 经营概览 skeleton spin waiting for it.
  const header = useRouteQuery(systemDashboardHeader, undefined, { enabled: canHeader });
  const trade = useRouteQuery(statsTrade, { query: range.query }, { enabled: canTrade });
  const orders = useRouteQuery(statsOrders, { query: range.query }, { enabled: canOrders });

  return (
    <PageContainer
      title={`你好，${identity.name}`}
      subTitle="今日概览与经营趋势"
      extra={<StatsRangePicker range={range} />}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {header.data?.degraded.length ? (
          <Alert
            type="warning"
            showIcon
            message="部分指标暂时不可用"
            description={`以下来源未能返回数据：${header.data.degraded.join('、')}。其余指标正常。`}
          />
        ) : null}

        {canHeader ? <HeaderTiles tiles={header.data?.tiles} loading={header.isPending} /> : null}

        {canTrade || canOrders ? (
          <div>
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              经营概览（{rangeLabel(range.value)}）
            </Typography.Title>
            <MetricCards
              metrics={overviewMetrics(trade.data?.metrics, orders.data?.metrics)}
              loading={(canTrade && trade.isPending) || (canOrders && orders.isPending)}
            />
          </div>
        ) : null}

        <Row gutter={[16, 16]}>
          {canTrade ? (
            <Col xs={24} xl={12}>
              <StatsChart chart={trade.data?.chart} loading={trade.isPending} title="交易趋势" />
            </Col>
          ) : null}
          {canOrders ? (
            <Col xs={24} xl={12}>
              <StatsChart chart={orders.data?.chart} loading={orders.isPending} title="订单趋势" />
            </Col>
          ) : null}
        </Row>

        {can('stats:product:read') ? (
          <ProductRankingTable
            query={range.query}
            defaultLimit={10}
            defaultSort="paidQuantity"
            controls={false}
            title="商品销量排行（前 10）"
            extra={<Link href="/admin/stats/products">查看全部</Link>}
          />
        ) : null}
      </Space>
    </PageContainer>
  );
}

/** The server's default window is the last 30 days; a picked one is shown as dates. */
function rangeLabel(value: [Dayjs, Dayjs] | null): string {
  if (!value) return '最近30天';
  const [from, to] = value;
  return from.isSame(to, 'day')
    ? from.format('YYYY-MM-DD')
    : `${from.format('YYYY-MM-DD')} 至 ${to.format('YYYY-MM-DD')}`;
}

/** 营业额 from 交易统计, the rest from 订单统计; whichever the admin may read. */
const OVERVIEW: [source: 'trade' | 'orders', key: string][] = [
  ['trade', 'revenue'],
  ['orders', 'paidOrderCount'],
  ['orders', 'refundOrderCount'],
  ['orders', 'refundRate'],
];

function overviewMetrics(
  trade: StatsMetric[] | undefined,
  orders: StatsMetric[] | undefined,
): StatsMetric[] | undefined {
  if (!trade && !orders) return undefined;
  return OVERVIEW.flatMap(([source, key]) => {
    const found = (source === 'trade' ? trade : orders)?.find((metric) => metric.key === key);
    return found ? [found] : [];
  });
}

function HeaderTiles({ tiles, loading }: { tiles: DashboardTile[] | undefined; loading: boolean }) {
  if (loading && !tiles) {
    return (
      <Row gutter={[16, 16]}>
        {Array.from({ length: 4 }, (_, index) => (
          <Col key={index} xs={12} md={6}>
            <Card size="small">
              <Skeleton active paragraph={{ rows: 1 }} title={false} />
            </Card>
          </Col>
        ))}
      </Row>
    );
  }
  if (!tiles?.length) return null;

  return (
    <Row gutter={[16, 16]}>
      {tiles.map((tile) => (
        <Col key={tile.key} xs={12} md={6}>
          {/* The whole card is the link — unless it holds links of its own. */}
          {tile.href && !tile.parts?.length ? (
            <Link href={tile.href} style={{ display: 'block', color: 'inherit' }}>
              <Card size="small" hoverable>
                <TileBody tile={tile} />
              </Card>
            </Link>
          ) : (
            <Card size="small">
              <TileBody tile={tile} />
            </Card>
          )}
        </Col>
      ))}
    </Row>
  );
}

function TileBody({ tile }: { tile: DashboardTile }) {
  // 「异常待处理」 and its like: work waiting for a person reads in the danger
  // colour while it is not zero, so it is seen before the sales figures.
  const alarming = tile.attention === true && tile.value > 0;
  const figure =
    tile.format === 'bytes' ? formatBytes(tile.value) : formatFigure(tile.value, tile.format);
  const head = (
    <>
      <Typography.Text type="secondary">{tile.label}</Typography.Text>
      <div style={{ fontSize: 24, lineHeight: '32px', fontVariantNumeric: 'tabular-nums' }}>
        {alarming ? (
          <Typography.Text type="danger" style={{ fontSize: 'inherit' }}>
            {figure}
          </Typography.Text>
        ) : (
          figure
        )}
      </div>
    </>
  );

  // One link per source, so 失败的后台任务 is one click away even while 异常支付 has work too.
  if (tile.parts?.length) {
    return (
      <>
        {tile.href ? (
          <Link href={tile.href} style={{ display: 'block', color: 'inherit' }}>
            {head}
          </Link>
        ) : (
          head
        )}
        <Space size={[12, 0]} wrap>
          {tile.parts.map((part) => (
            <Link key={part.key} href={part.href} style={{ fontSize: 12 }}>
              <Typography.Text
                type={part.value > 0 ? 'danger' : 'secondary'}
                style={{ fontSize: 'inherit' }}
              >
                {part.label} {formatFigure(part.value, 'count')}
              </Typography.Text>
            </Link>
          ))}
        </Space>
      </>
    );
  }

  return (
    <>
      {head}
      {tile.attention ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {alarming ? '点击查看并处理' : '暂无'}
        </Typography.Text>
      ) : (
        <TileDelta tile={tile} />
      )}
    </>
  );
}

function TileDelta({ tile }: { tile: DashboardTile }) {
  if (tile.deltaFromYesterday === null) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        —
      </Typography.Text>
    );
  }
  if (tile.deltaFromYesterday === 0) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        较昨日持平
      </Typography.Text>
    );
  }
  const up = tile.deltaFromYesterday > 0;
  const shown =
    tile.format === 'bytes'
      ? formatBytes(Math.abs(tile.deltaFromYesterday))
      : formatFigure(Math.abs(tile.deltaFromYesterday), tile.format);
  return (
    <Typography.Text type={up ? 'success' : 'danger'} style={{ fontSize: 12 }}>
      较昨日 {up ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {shown}
    </Typography.Text>
  );
}

function formatBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
