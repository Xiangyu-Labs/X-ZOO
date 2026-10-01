import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import {
  flattenPages,
  routeKey,
  useInfiniteRouteQuery,
  useRouteMutation,
} from '@shop/api-client/react';
import { LIST_FULL_RELOAD_AFTER_MS, useRefetchOnShow } from '@/data/use-refetch-on-show';
import { assetUrl } from '@/lib/asset-url';
import { formatDate } from '@/lib/format';
import { navigate, useRouteParams } from '@/platform';
import { LoginGate } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { Radio } from '@/ui/choice';
import { Empty } from '@/ui/empty';
import { confirm, toast } from '@/ui/feedback';
import { Icon } from '@/ui/icon';
import { Image } from '@/ui/image';
import { InfiniteList } from '@/ui/infinite-list';
import { PageShell } from '@/ui/page-shell';
import { Price } from '@/ui/price';
import { Pressable } from '@/ui/pressable';
import { CellSkeleton } from '@/ui/skeleton';
import { Tabs } from '@/ui/tabs';
import { Tag } from '@/ui/tag';
import { SubmitBar, errorMessage } from '../shared/form';
import {
  HEADER_TYPE_TEXT,
  invoiceStateOf,
  INVOICE_TITLE_READS,
  orderSummaryText,
  titleSummary,
  type InvoiceTitle,
  type OrderInvoice,
} from '../shared/invoice';
import './index.scss';

type Tab = 'titles' | 'records';

const TABS = [
  { key: 'titles', label: '发票抬头' },
  { key: 'records', label: '开票记录' },
] as const;

/** The server keeps at most this many titles (`USER_INVOICE_TITLE_LIMIT_REACHED`). */
const TITLE_LIMIT = 20;

/**
 * 发票 (`invoices { tab? }`, pages.md §2.6): two tabs as before — 发票抬头 (now kept on the
 * server) and 开票记录. Invoices are asked for from an order (申请开票).
 */
export default function InvoicesPage() {
  const params = useRouteParams('invoices');
  const [tab, setTab] = useState<Tab>(params.tab === 'records' ? 'records' : 'titles');
  const signedIn = useSignedIn();
  return (
    <PageShell title="发票" withBar={signedIn && tab === 'titles'}>
      <LoginGate reason="登录后可以管理发票" redirect={{ route: 'invoices', params: { tab } }}>
        <Tabs items={TABS} value={tab} onChange={setTab} sticky />
        {tab === 'titles' ? <Titles /> : <Records />}
      </LoginGate>
    </PageShell>
  );
}

function Titles() {
  const signedIn = useSignedIn();
  const list = useInfiniteRouteQuery(
    'user.invoiceTitleList',
    { query: { pageSize: 20 } },
    { enabled: signedIn },
  );
  const remove = useRouteMutation('user.invoiceTitleDelete', {
    invalidate: INVOICE_TITLE_READS,
  });
  const setDefault = useRouteMutation('user.invoiceTitleSetDefault', {
    invalidate: INVOICE_TITLE_READS,
  });
  const count = list.data?.pages[0]?.total ?? flattenPages(list.data).length;
  const full = count >= TITLE_LIMIT;

  async function del(title: InvoiceTitle) {
    const ok = await confirm({
      title: '删除发票抬头',
      content: `删除「${title.name}」？已申请的发票不受影响。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync({ params: { id: title.id } });
      toast.success('已删除');
    } catch (error) {
      toast.text(errorMessage(error));
    }
  }

  return (
    <View className="account-page">
      <InfiniteList
        query={list}
        itemKey={(title) => title.id}
        skeleton={<CellSkeleton rows={3} />}
        empty={<Empty title="还没有发票抬头" description="保存常用抬头，申请开票时一键填入" />}
        renderItem={(title) => (
          <View className="invoice-title">
            <Pressable
              label={`${title.name}，编辑`}
              className="invoice-title__main"
              onClick={() => navigate({ route: 'invoiceTitleEdit', params: { id: title.id } })}
            >
              <View className="invoice-title__head">
                <Text className="invoice-title__name">{title.name}</Text>
                <Tag tone="neutral" size="sm">
                  {HEADER_TYPE_TEXT[title.headerType]}
                </Tag>
                {title.isDefault ? (
                  <Tag tone="primary" size="sm">
                    默认
                  </Tag>
                ) : null}
              </View>
              <Text className="invoice-title__summary">{titleSummary(title)}</Text>
            </Pressable>
            <View className="invoice-title__actions">
              <Radio
                label={title.isDefault ? '默认抬头' : '设为默认'}
                checked={title.isDefault}
                onChange={() =>
                  title.isDefault
                    ? undefined
                    : setDefault
                        .mutateAsync({ params: { id: title.id }, body: {} })
                        .catch((error: unknown) => toast.text(errorMessage(error)))
                }
              />
              <Button
                variant="text"
                size="sm"
                label={`删除「${title.name}」`}
                onClick={() => del(title)}
              >
                删除
              </Button>
            </View>
          </View>
        )}
      />
      {full ? <Text className="account-note">最多保存 {TITLE_LIMIT} 个抬头</Text> : null}
      <SubmitBar>
        <Button
          size="lg"
          block
          disabled={full}
          onClick={() => navigate({ route: 'invoiceTitleEdit', params: {} })}
        >
          新增发票抬头
        </Button>
      </SubmitBar>
    </View>
  );
}

function Records() {
  const signedIn = useSignedIn();
  const list = useInfiniteRouteQuery(
    'order.myInvoices',
    { query: { pageSize: 20 } },
    { enabled: signedIn },
  );
  // The merchant issues or rejects a request while the shopper is elsewhere.
  useRefetchOnShow(routeKey('order.myInvoices'), {
    pages: 'first',
    allPagesAfter: LIST_FULL_RELOAD_AFTER_MS,
  });
  return (
    <View className="account-page">
      <InfiniteList
        query={list}
        itemKey={(invoice) => invoice.id}
        skeleton={<CellSkeleton rows={3} />}
        empty={<Empty title="还没有开票记录" description="在订单详情里可以申请开票" />}
        renderItem={(invoice) => <RecordRow invoice={invoice} />}
      />
    </View>
  );
}

function RecordRow({ invoice }: { invoice: OrderInvoice }) {
  const state = invoiceStateOf(invoice);
  return (
    <Pressable
      label={`${invoice.name}，${state.text}，查看详情`}
      role="link"
      className="invoice-record"
      onClick={() => navigate({ route: 'invoice', params: { id: invoice.id } })}
    >
      <View className="invoice-record__head">
        <Text className="invoice-record__name">{invoice.name}</Text>
        <Tag tone={state.tone} size="sm">
          {state.text}
        </Tag>
      </View>
      <View className="invoice-record__order">
        {invoice.orderSummary ? (
          <View className="invoice-record__thumb">
            <Image
              src={assetUrl(invoice.orderSummary.productImageUrl)}
              ratio={1}
              radius="sm"
              size="small"
            />
          </View>
        ) : null}
        <View className="invoice-record__text">
          <Text className="invoice-record__summary">{orderSummaryText(invoice)}</Text>
          <Text className="invoice-record__date">申请于 {formatDate(invoice.createdAt)}</Text>
        </View>
        <Price value={invoice.amount} size="sm" tone="text" prefix="开票金额" />
        <Icon name="chevron-right" className="invoice-record__arrow" />
      </View>
    </Pressable>
  );
}
