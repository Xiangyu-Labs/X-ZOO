'use client';

import { useState } from 'react';
import { App, Button, Card, Col, Row, Select, Space, Statistic, Tabs } from 'antd';
import { useSearchParams } from 'next/navigation';
import {
  orderAdminDeleteMany,
  orderAdminExport,
  orderAdminList,
  orderAdminStatistics,
} from '@shop/contracts/order/order.admin.contract';
import type { OrderDeletionsResult } from '@shop/contracts/order/order.fulfil.schemas';

import { callRoute, presentApiError, presentSuccess, useRouteQuery } from '@/admin/api';
import { ConfirmButton } from '@/admin/kit/confirm-button';
import { MoneyText } from '@/admin/kit/money-text';
import { PageContainer } from '@/admin/kit/page-container';
import { CrudTable } from '@/admin/kit/table/crud-table';
import { filterKeys, type FilterSpec } from '@/admin/kit/table/filter-bar';
import { useNextUrlState } from '@/admin/kit/table/url-state';
import { Can, useCan } from '@/admin/session';

import { OrderCard } from './order-card';
import { OrderShipDrawer, type OrderShipTarget } from './order-ship-drawer';
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
  { key: 'refunding', label: '售后中', query: { refunding: true } },
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

export function OrdersPage() {
  // The tab lives in the URL next to the filters and the page, so 返回列表
  // from an order lands on the same screen.
  const urlState = useNextUrlState();
  const initial = urlState.read('tab');
  const [tab, setTab] = useState<TabKey>(isTab(initial) ? initial : 'all');
  const [shipTarget, setShipTarget] = useState<OrderShipTarget | null>(null);
  const changeTab = (next: TabKey): void => {
    setTab(next);
    // Page 1: what was row 40 of 全部 is not row 40 of 售后中.
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
  const canDelete = can('order:order:delete');
  const stats = useRouteQuery(orderAdminStatistics, {}, { enabled: canStats });
  const preset = TABS.find((entry) => entry.key === tab)?.query ?? {};

  return (
    <PageContainer
      subTitle="按订单状态处理发货、物流与售后，支持按类型筛选和导出"
      tabs={
        <Tabs
          activeKey={tab}
          onChange={(key) => changeTab(key as TabKey)}
          items={TABS.map((entry) => ({ key: entry.key, label: entry.label }))}
        />
      }
    >
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

      <CrudTable
        key={tab}
        route={orderAdminList}
        columns={[]}
        fixedQuery={preset}
        toolbar={<OrdersToolbar preset={preset} />}
        batchActions={
          canDelete
            ? ({ selectedRowKeys, clear }) => (
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
              )
            : undefined
        }
        filters={FILTERS}
        renderCard={(row, selection) => (
          <OrderCard
            row={row}
            detailHref={detailHref(row.id)}
            selected={selection.selected}
            selectable={selection.selectable}
            onToggle={selection.toggle}
            onShip={(target) => setShipTarget({ orderId: target.id, mode: 'ship' })}
            onLogistics={(target) => setShipTarget({ orderId: target.id, mode: 'logistics' })}
          />
        )}
      />

      <OrderShipDrawer target={shipTarget} onClose={() => setShipTarget(null)} />
    </PageContainer>
  );
}

function OrdersToolbar({ preset }: { preset: Record<string, unknown> }) {
  return (
    <Space wrap>
      <ExportButton preset={preset} />
      <SortSelect />
    </Space>
  );
}

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'createdAt:desc', label: '最新下单' },
  { value: 'createdAt:asc', label: '最早下单' },
  { value: 'payableAmount:desc', label: '应付从高到低' },
  { value: 'payableAmount:asc', label: '应付从低到高' },
];

function SortSelect() {
  const { read, write } = useNextUrlState();
  const raw = read('sort') ?? 'createdAt:desc';
  const value = SORT_OPTIONS.some((option) => option.value === raw) ? raw : 'createdAt:desc';

  return (
    <Select
      aria-label="排序"
      value={value}
      options={SORT_OPTIONS}
      style={{ width: 160 }}
      onChange={(next) => write({ sort: next, page: '1' })}
    />
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
    <Card size="small" style={{ marginBottom: 16 }}>
      <Row gutter={[16, 16]}>
        {[
          { title: '待发货', value: props.pendingShipment },
          { title: '待收货', value: props.pendingReceipt },
          { title: '售后中', value: props.refunding },
          { title: '待开票', value: props.pendingInvoice },
        ].map((entry) => (
          <Col key={entry.title} flex="1 1 160px">
            <Statistic title={entry.title} value={entry.value} loading={props.loading} />
          </Col>
        ))}
        <Col flex="1 1 180px">
          <Statistic
            title="近 30 天实付"
            loading={props.loading}
            valueRender={() => <MoneyText value={props.paidAmount} strong />}
          />
        </Col>
      </Row>
    </Card>
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
