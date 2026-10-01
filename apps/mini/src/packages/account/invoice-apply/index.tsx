import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import { isApiError } from '@shop/api-client';
import { useRouteMutation, useRouteQuery } from '@shop/api-client/react';
import { navigate, useRouteParams } from '@/platform';
import { LoginGate } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { Cell, CellGroup } from '@/ui/cell';
import { Radio } from '@/ui/choice';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { alert, toast } from '@/ui/feedback';
import { Textarea } from '@/ui/field';
import { Icon } from '@/ui/icon';
import { PageShell } from '@/ui/page-shell';
import { Price } from '@/ui/price';
import { Pressable } from '@/ui/pressable';
import { CellSkeleton } from '@/ui/skeleton';
import { SubmitBar, errorMessage } from '../shared/form';
import {
  invoiceRequestFromTitle,
  titleSummary,
  useCreatedInvoiceTitle,
  type InvoiceTitle,
} from '../shared/invoice';
import './index.scss';

/**
 * 申请开票 (`invoiceApply { orderId }`, pages.md §2.6), from 订单详情: pick a saved 抬头 (the
 * default one first) or add one, and send it. The fields are copied onto the request, so
 * editing the title later never changes it.
 */
export default function InvoiceApplyPage() {
  const { orderId } = useRouteParams('invoiceApply');
  const signedIn = useSignedIn();
  return (
    <PageShell title="申请开票" withBar={signedIn && Boolean(orderId)}>
      {orderId ? (
        <LoginGate
          reason="登录后可以申请开票"
          redirect={{ route: 'invoiceApply', params: { orderId } }}
        >
          <Apply orderId={orderId} />
        </LoginGate>
      ) : (
        <Empty image="order" title="没有找到这个订单" />
      )}
    </PageShell>
  );
}

function Apply({ orderId }: { orderId: string }) {
  const signedIn = useSignedIn();
  // A title saved on an earlier visit is not this visit's choice.
  useState(() => useCreatedInvoiceTitle.setState({ id: null }));
  const order = useRouteQuery('order.detail', { params: { id: orderId } }, { enabled: signedIn });
  const titles = useRouteQuery(
    'user.invoiceTitleList',
    { query: { page: 1, pageSize: 20 } },
    { enabled: signedIn },
  );
  const created = useCreatedInvoiceTitle((state) => state.id);
  const [picked, setPicked] = useState<string | null>(null);
  const [remark, setRemark] = useState('');
  const submit = useRouteMutation('order.invoiceRequest', {
    invalidate: ['order.myInvoices', 'order.detail'],
  });

  if (order.isPending || titles.isPending) return <CellSkeleton rows={5} />;
  if (order.isError) return <ErrorBlock error={order.error} onRetry={() => order.refetch()} />;
  if (titles.isError) {
    return <ErrorBlock error={titles.error} onRetry={() => titles.refetch()} />;
  }
  const items = titles.data.items;
  const chosenId =
    [picked, created].find((id) => id && items.some((t) => t.id === id)) ??
    items.find((t) => t.isDefault)?.id ??
    items[0]?.id ??
    null;
  const chosen = items.find((t) => t.id === chosenId) ?? null;
  const first = order.data.items[0];

  // Opened from an old link or a stale page: say why instead of offering a request the server
  // refuses (INVOICE-004).
  if (!order.data.invoiceRequestable) {
    return (
      <Empty
        image="order"
        title="这个订单暂不能申请开票"
        description="已申请过的可在「开票记录」查看；已全额退款或实付为 0 的订单不能开票"
        actions={
          <Button
            variant="outline-primary"
            size="md"
            onClick={() =>
              navigate({ route: 'invoices', params: { tab: 'records' } }, { replace: true })
            }
          >
            开票记录
          </Button>
        }
      />
    );
  }

  function addTitle() {
    setPicked(null);
    void navigate({ route: 'invoiceTitleEdit', params: {} });
  }

  async function send(title: InvoiceTitle) {
    const note = remark.trim();
    try {
      const invoice = await submit.mutateAsync({
        params: { id: orderId },
        body: { ...invoiceRequestFromTitle(title), ...(note ? { remark: note } : {}) },
      });
      toast.success('已提交开票申请');
      await navigate({ route: 'invoice', params: { id: invoice.id } }, { replace: true });
    } catch (error) {
      if (
        isApiError(error, 'order.invoiceRequest') &&
        error.code === 'ORDER_INVOICE_ALREADY_OPEN'
      ) {
        await alert('这个订单已经申请过开票，可在「开票记录」里查看。');
        return;
      }
      toast.text(errorMessage(error));
    }
  }

  return (
    <View className="account-page">
      <CellGroup title="订单">
        <Cell
          title={first ? first.productName : `订单 ${order.data.orderNo}`}
          description={`订单号 ${order.data.orderNo}`}
          value={
            <Price
              // Paid less refunded: what the invoice is made out for.
              value={order.data.invoiceAmount}
              size="sm"
              tone="text"
              prefix="开票金额"
            />
          }
        />
      </CellGroup>
      <CellGroup title="发票抬头">
        {items.map((title) => (
          <Radio
            key={title.id}
            label={`${title.name}，${titleSummary(title)}`}
            checked={title.id === chosenId}
            className="invoice-apply__title"
            onChange={() => setPicked(title.id)}
          >
            <View className="invoice-apply__title-text">
              <Text className="invoice-apply__title-name">{title.name}</Text>
              <Text className="invoice-apply__title-summary">{titleSummary(title)}</Text>
            </View>
          </Radio>
        ))}
        <Pressable label="新增发票抬头" className="invoice-apply__add" onClick={addTitle}>
          <Icon name="plus" />
          <Text>新增发票抬头</Text>
        </Pressable>
      </CellGroup>
      <CellGroup title="备注（选填）">
        <Textarea
          label="备注"
          placeholder="给商家的说明，例如开票内容要求"
          value={remark}
          maxLength={255}
          onChange={setRemark}
        />
      </CellGroup>
      <Text className="account-note">发票由商家人工开具，开具后会通知你。</Text>
      <SubmitBar>
        <Button
          size="lg"
          block
          disabled={!chosen}
          loading={submit.isPending}
          // The promise keeps the button busy until the request settles (no second request).
          onClick={() => (chosen ? send(chosen) : undefined)}
        >
          提交申请
        </Button>
      </SubmitBar>
    </View>
  );
}
