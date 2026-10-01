'use client';

import { Card, Col, Row, Statistic, Typography } from 'antd';
import { useMemo } from 'react';
import {
  paymentAdminCapitalFlowList,
  paymentAdminCapitalFlowSummary,
} from '@shop/contracts/payment/payment.admin.contract';
import type { CapitalFlowListItem } from '@shop/contracts/payment/schemas';

import { useRouteQuery } from '@/admin/api/hooks';
import { formatMoney } from '@/admin/kit/money';
import { MoneyText } from '@/admin/kit/money-text';
import { PageContainer } from '@/admin/kit/page-container';
import {
  codeColumn,
  enumColumn,
  idColumn,
  instantColumn,
  textColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { useNextUrlState } from '@/admin/kit/table/url-state';

import { CAPITAL_FLOW_DIRECTION, CAPITAL_FLOW_KIND, optionsOf } from '../trade-enums';

/**
 * 资金流水 — one row per movement of money, in or out.
 *
 * The ledger is written by the code paths that move the money, inside the same
 * transaction as the state change, with a `UNIQUE (kind, reference)` behind it.
 * That is what makes it worth reading: a replayed callback cannot add a second
 * row, and a row cannot exist for money that never moved.
 *
 * The three totals are computed over the **whole filter**, not the current
 * page, which is the only version of that number anyone wants. They come from a
 * separate route sharing the filter's query keys, so a period's net is a
 * shareable URL.
 */
const FILTER_KEYS = [
  'kind',
  'direction',
  'orderId',
  'userId',
  'keyword',
  'occurredFrom',
  'occurredTo',
] as const;

export function CapitalFlowsPage() {
  const { read } = useNextUrlState();

  // The same keys `CrudTable` writes, minus paging: the summary is over
  // everything that matches. `kind` is multi-select and travels as `a,b`.
  const summaryQuery = useMemo(() => {
    const query: Record<string, unknown> = {};
    for (const name of FILTER_KEYS) {
      const value = read(name);
      if (value === undefined || value === '') continue;
      query[name] = name === 'kind' ? value.split(',').filter(Boolean) : value;
    }
    return query;
  }, [read]);

  const summary = useRouteQuery(paymentAdminCapitalFlowSummary, { query: summaryQuery } as never);
  const totals = summary.data;

  return (
    <PageContainer subTitle="每一笔实际发生的收支；同一笔钱只会有一行">
      <Card size="small" style={{ marginBottom: 16 }} loading={summary.isPending}>
        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Statistic
              title="收入"
              value={totals ? formatMoney(totals.inAmount) : '—'}
              valueStyle={{ color: 'var(--ant-color-success)' }}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="支出"
              value={totals ? formatMoney(totals.outAmount) : '—'}
              valueStyle={{ color: 'var(--ant-color-error)' }}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="净额" value={totals ? formatMoney(totals.netAmount) : '—'} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="笔数" value={totals?.count ?? '—'} />
          </Col>
        </Row>
      </Card>

      <CrudTable
        route={paymentAdminCapitalFlowList}
        scrollX={1400}
        filters={[
          { kind: 'text', name: 'keyword', label: '单号' },
          {
            kind: 'select',
            name: 'kind',
            label: '类型',
            multiple: true,
            options: optionsOf(CAPITAL_FLOW_KIND),
          },
          {
            kind: 'select',
            name: 'direction',
            label: '方向',
            options: optionsOf(CAPITAL_FLOW_DIRECTION),
          },
          { kind: 'number', name: 'orderId', label: '订单 ID' },
          { kind: 'number', name: 'userId', label: '用户 ID' },
          { kind: 'dateRange', names: ['occurredFrom', 'occurredTo'], label: '发生时间' },
        ]}
        columns={[
          idColumn<CapitalFlowListItem>({ sortable: true }),
          enumColumn<CapitalFlowListItem, CapitalFlowListItem['kind']>({
            title: '类型',
            dataIndex: 'kind',
            map: CAPITAL_FLOW_KIND,
            width: 120,
          }),
          enumColumn<CapitalFlowListItem, CapitalFlowListItem['direction']>({
            title: '方向',
            dataIndex: 'direction',
            map: CAPITAL_FLOW_DIRECTION,
            width: 90,
          }),
          {
            title: '金额',
            dataIndex: 'amount',
            key: 'amount',
            width: 130,
            align: 'right' as const,
            sorter: true,
            showSorterTooltip: false,
            render: (_value: unknown, row: CapitalFlowListItem) => (
              <Typography.Text type={row.direction === 'in' ? 'success' : 'danger'}>
                {row.direction === 'in' ? '+' : '-'}
                <MoneyText value={row.amount} />
              </Typography.Text>
            ),
          },
          codeColumn<CapitalFlowListItem>({ title: '单号', dataIndex: 'reference' }),
          codeColumn<CapitalFlowListItem>({
            title: '订单',
            dataIndex: 'orderNo',
            href: (row) => (row.orderId ? `/admin/orders/${row.orderId}` : null),
          }),
          codeColumn<CapitalFlowListItem>({
            title: '微信单号',
            dataIndex: 'transactionId',
            chars: 28,
          }),
          textColumn<CapitalFlowListItem>({ title: '备注', dataIndex: 'note', ellipsis: true }),
          instantColumn<CapitalFlowListItem>({
            title: '发生时间',
            dataIndex: 'occurredAt',
            sortable: true,
          }),
        ]}
      />
    </PageContainer>
  );
}
