'use client';

import { useState } from 'react';
import { App, Button, Card, Col, Row, Space, Statistic, Tabs, Tag, Typography } from 'antd';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  orderAdminDeleteMany,
  orderAdminExport,
  orderAdminList,
  orderAdminStatistics,
} from '@shop/contracts/order/order.admin.contract';
import type {
  AdminOrderListItem,
  OrderDeletionsResult,
} from '@shop/contracts/order/order.fulfil.schemas';

import { callRoute, presentApiError, presentSuccess, useRouteQuery } from '@/admin/api';
import { MoneyText } from '@/admin/kit/money-text';
import { PageContainer } from '@/admin/kit/page-container';
import { StatusTag } from '@/admin/kit/status-tag';
import {
  actionsColumn,
  CodeText,
  codeWidth,
  enumColumn,
  instantColumn,
  moneyColumn,
} from '@/admin/kit/table/columns';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { filterKeys, type FilterSpec } from '@/admin/kit/table/filter-bar';
import { useNextUrlState } from '@/admin/kit/table/url-state';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { Can, useCan } from '@/admin/session';

import {
  FULFILLMENT_STATUS,
  ORDER_KIND,
  ORDER_STATUS,
  REFUND_STATUS,
  optionsOf,
} from './order-enums';

/**
 * 订单列表.
 *
 * The tab bar is a *preset over the filters*, not a separate query parameter.
 * Packing 待发货 / 待收货 / 已完成 into one `status` integer would mix four
 * different columns together, and 已退款 and 待收货 could never be asked for
 * at once; here each tab just sets the filters it means and the
 * filter bar underneath stays usable on top of it.
 */

type TabKey = 'all' | 'unpaid' | 'unshipped' | 'unreceived' | 'finished' | 'refunding' | 'deleted';

const TABS: { key: TabKey; label: string; query: Record<string, unknown> }[] = [
  { key: 'all', label: '全部', query: {} },
  { key: 'unpaid', label: '待付款', query: { status: 'pending_payment' } },
  {
    key: 'unshipped',
    label: '待发货',
    query: { status: 'paid', fulfillmentStatus: ['unfulfilled', 'partially_fulfilled'] },
  },
  { key: 'unreceived', label: '待收货', query: { status: 'shipped' } },
  { key: 'finished', label: '已完成', query: { status: ['received', 'completed'] } },
  // An open after-sales request, not the `partially_refunded` roll-up that
  // stays on an order after its request has closed.
  { key: 'refunding', label: '退款中', query: { refunding: true } },
  { key: 'deleted', label: '回收站', query: { deleted: true } },
];

const isTab = (value: string | undefined): value is TabKey =>
  TABS.some((entry) => entry.key === value);

const FILTERS: FilterSpec[] = [
  { kind: 'text', name: 'keyword', label: '关键词' },
  {
    kind: 'select',
    name: 'status',
    label: '订单状态',
    multiple: true,
    options: optionsOf(ORDER_STATUS),
  },
  {
    kind: 'select',
    name: 'fulfillmentStatus',
    label: '发货状态',
    multiple: true,
    options: optionsOf(FULFILLMENT_STATUS),
  },
  {
    kind: 'select',
    name: 'refundStatus',
    label: '售后状态',
    multiple: true,
    options: optionsOf(REFUND_STATUS),
  },
  { kind: 'select', name: 'kind', label: '订单类型', options: optionsOf(ORDER_KIND) },
  { kind: 'number', name: 'userId', label: '用户 ID' },
  { kind: 'dateRange', names: ['createdFrom', 'createdTo'], label: '下单时间' },
  { kind: 'dateRange', names: ['paidFrom', 'paidTo'], label: '支付时间' },
];

/** 拼团 not yet 成团: paid, but not to be shipped. */
const teamForming = (row: AdminOrderListItem): boolean =>
  row.groupbuyTeamStatus !== null && row.groupbuyTeamStatus !== 'succeeded';

export function OrdersPage() {
  // The tab lives in the URL next to the filters and the page, so 返回列表
  // from an order lands on the same screen.
  const urlState = useNextUrlState();
  const initial = urlState.read('tab');
  const [tab, setTab] = useState<TabKey>(isTab(initial) ? initial : 'all');
  const changeTab = (next: TabKey): void => {
    setTab(next);
    // Page 1: what was row 40 of 全部 is not row 40 of 退款中.
    urlState.write({ tab: next === 'all' ? undefined : next, page: '1' });
  };
  // The detail's 返回 goes back to this exact list: tab, filters and page.
  const listSearch = useSearchParams().toString();
  const detailHref = (id: string): string =>
    listSearch
      ? `/admin/orders/${id}?list=${encodeURIComponent(listSearch)}`
      : `/admin/orders/${id}`;
  // The work queue is 订单统计: a role that may list orders but not read the
  // statistics sees the list without it, not four zeros and a 403 toast.
  const can = useCan();
  const canStats = can('order:stats:read');
  const stats = useRouteQuery(orderAdminStatistics, {}, { enabled: canStats });
  const preset = TABS.find((entry) => entry.key === tab)?.query ?? {};

  return (
    <PageContainer subTitle="发货、改价、备注与导出。拆单已经取消，部分发货只是多一张发货单。">
      {canStats && (
        <WorkQueue
          pendingShipment={stats.data?.pendingShipment ?? 0}
          pendingReceipt={stats.data?.pendingReceipt ?? 0}
          refunding={stats.data?.refunding ?? 0}
          pendingInvoice={stats.data?.pendingInvoice ?? 0}
          paidAmount={stats.data?.paidAmount ?? null}
          loading={stats.isPending}
        />
      )}

      <Tabs
        activeKey={tab}
        onChange={(key) => changeTab(key as TabKey)}
        items={TABS.map((entry) => ({ key: entry.key, label: entry.label }))}
      />

      <CrudTable
        key={tab}
        route={orderAdminList}
        scrollX={1600}
        fixedQuery={preset}
        toolbar={<ExportButton preset={preset} />}
        batchActions={({ selectedRowKeys, clear }) => (
          <Can permission="order:order:delete">
            <ConfirmButton
              route={orderAdminDeleteMany}
              input={{ body: { ids: selectedRowKeys.map(String) } }}
              title={`确认删除选中的 ${selectedRowKeys.length} 个订单？`}
              description="只删除已完成、已取消或已退款且没有售后在处理的订单，其余会被跳过。"
              invalidate={[orderAdminList, orderAdminStatistics]}
              onSuccess={(result) => {
                const { deleted, skippedIds } = result as OrderDeletionsResult;
                presentSuccess(
                  skippedIds.length === 0
                    ? `已删除 ${deleted} 个订单`
                    : `已删除 ${deleted} 个订单，跳过 ${skippedIds.length} 个未完成或有售后在处理的订单`,
                );
                clear();
              }}
              buttonProps={{ danger: true }}
            >
              批量删除
            </ConfirmButton>
          </Can>
        )}
        filters={FILTERS}
        columns={[
          {
            title: '订单号',
            dataIndex: 'orderNo',
            key: 'orderNo',
            width: codeWidth(26),
            render: (_value: unknown, row: AdminOrderListItem) => (
              <CodeText value={row.orderNo} href={detailHref(row.id)} />
            ),
          },
          {
            title: '买家',
            key: 'user',
            width: 150,
            render: (_value: unknown, row: AdminOrderListItem) => (
              <Typography.Text ellipsis>
                {row.user.nickname}
                <Typography.Text type="secondary"> #{row.user.id}</Typography.Text>
              </Typography.Text>
            ),
          },
          {
            title: '收货人',
            key: 'receiver',
            width: 170,
            render: (_value: unknown, row: AdminOrderListItem) => (
              <Typography.Text ellipsis>
                {row.receiver.name} {row.receiver.phone}
              </Typography.Text>
            ),
          },
          {
            title: '商品',
            key: 'items',
            width: 220,
            render: (_value: unknown, row: AdminOrderListItem) => (
              <Typography.Text type="secondary" ellipsis>
                {row.items[0]?.productName ?? '—'}
                {row.items.length > 1 ? ` 等 ${row.items.length} 件` : ''}
              </Typography.Text>
            ),
          },
          moneyColumn<AdminOrderListItem>({
            title: '应付',
            dataIndex: 'payableAmount',
            sortable: true,
          }),
          moneyColumn<AdminOrderListItem>({ title: '实付', dataIndex: 'paidAmount' }),
          moneyColumn<AdminOrderListItem>({ title: '已退款', dataIndex: 'refundedAmount' }),
          enumColumn<AdminOrderListItem, AdminOrderListItem['status']>({
            title: '状态',
            dataIndex: 'status',
            map: ORDER_STATUS,
          }),
          {
            title: '发货 / 售后',
            key: 'progress',
            width: 170,
            render: (_value: unknown, row: AdminOrderListItem) => (
              <Space size={4}>
                {teamForming(row) ? (
                  <Tag color="orange">
                    {row.groupbuyTeamStatus === 'forming' ? '拼团中' : '未成团'}
                  </Tag>
                ) : null}
                <StatusTag value={row.fulfillmentStatus} map={FULFILLMENT_STATUS} />
                {row.refundStatus === 'none' ? null : (
                  <StatusTag value={row.refundStatus} map={REFUND_STATUS} />
                )}
              </Space>
            ),
          },
          instantColumn<AdminOrderListItem>({
            title: '下单时间',
            dataIndex: 'createdAt',
            sortable: true,
          }),
          actionsColumn<AdminOrderListItem>({
            render: (row) => (
              <Link href={detailHref(row.id)}>
                <Button type="link" size="small">
                  {row.status === 'paid' &&
                  row.fulfillmentStatus !== 'fulfilled' &&
                  !teamForming(row)
                    ? '去发货'
                    : '详情'}
                </Button>
              </Link>
            ),
          }),
        ]}
      />
    </PageContainer>
  );
}

function WorkQueue(props: {
  pendingShipment: number;
  pendingReceipt: number;
  refunding: number;
  pendingInvoice: number;
  paidAmount: string | null;
  loading: boolean;
}) {
  return (
    <Row gutter={16} style={{ marginBottom: 16 }}>
      {[
        { title: '待发货', value: props.pendingShipment },
        { title: '待收货', value: props.pendingReceipt },
        { title: '退款中', value: props.refunding },
        { title: '待开票', value: props.pendingInvoice },
      ].map((entry) => (
        <Col key={entry.title} span={5}>
          <Card size="small">
            <Statistic title={entry.title} value={entry.value} loading={props.loading} />
          </Card>
        </Col>
      ))}
      <Col span={4}>
        <Card size="small">
          <Statistic
            title="近 30 天实付"
            loading={props.loading}
            valueRender={() => <MoneyText value={props.paidAmount} strong />}
          />
        </Card>
      </Col>
    </Row>
  );
}

/**
 * 导出.
 *
 * The response is CSV *text* in the JSON envelope — `handle()` validates every
 * response against its contract, so a route cannot answer with a binary stream.
 * The download is assembled here, with a BOM so Excel reads UTF-8.
 */
function ExportButton({ preset }: { preset: Record<string, unknown> }) {
  const [busy, setBusy] = useState(false);
  const { message } = App.useApp();
  const { read } = useNextUrlState();

  /** The tab's preset plus whatever the filter bar holds — what the table shows. */
  const exportQuery = (): Record<string, unknown> => {
    const query: Record<string, unknown> = { ...preset };
    for (const spec of FILTERS) {
      for (const name of filterKeys(spec)) {
        const value = read(name);
        if (value === undefined || value === '') continue;
        query[name] =
          spec.kind === 'select' && spec.multiple ? value.split(',').filter(Boolean) : value;
      }
    }
    return query;
  };

  const download = async () => {
    setBusy(true);
    try {
      const result = await callRoute(orderAdminExport, {
        query: { ...exportQuery(), kindOfExport: 'orders' } as never,
      });
      const blob = new Blob(['\uFEFF', result.content], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      if (result.truncated) {
        void message.warning(`导出已截断到 ${result.rowCount} 行，请缩小筛选范围`);
      }
    } catch (error) {
      presentApiError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Can permission="order:order:export">
      <Button onClick={download} loading={busy}>
        导出 CSV
      </Button>
    </Can>
  );
}
