import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Text, View } from '@tarojs/components';
import { isApiError } from '@shop/api-client';
import {
  routeQueryKey,
  useApiClient,
  useInvalidateRoutes,
  useRouteQuery,
} from '@shop/api-client/react';
import { DECOR_PAGE_READS, markStale } from '@/data/stale-reads';
import { useRefetchOnShow } from '@/data/use-refetch-on-show';
import { leaveFor, navigate, platform, useRouteParams } from '@/platform';
import { LoginCard } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Countdown } from '@/ui/countdown';
import { Empty } from '@/ui/empty';
import { ErrorBlock } from '@/ui/error-block';
import { Icon } from '@/ui/icon';
import { PageShell } from '@/ui/page-shell';
import { Price } from '@/ui/price';
import { Pressable } from '@/ui/pressable';
import { Result } from '@/ui/result';
import { CellSkeleton } from '@/ui/skeleton';
import { errorMessage } from '@/lib/error-message';
import { CANCEL_READS } from '../shared/actions';
import './index.scss';

/**
 * 收银台 (`cashier { orderId }`): the amount, the time left to pay (`payExpiresAt`), 微信支付.
 * `payment.start` with `wechat_mini`, then `wx.requestPayment`. Paid (as WeChat's sheet says)
 * goes on to 支付结果, which asks the server (C06). A closed sheet stays here; a failed one asks
 * the server once — the money may have moved after all — and otherwise stays with the reason
 * and 重新支付.
 */
export default function CashierPage() {
  const { orderId = '' } = useRouteParams('cashier');
  return (
    <PageShell title="收银台" withBar>
      <LoginCard reason="登录后即可支付" redirect={{ route: 'cashier', params: { orderId } }}>
        {orderId === '' ? <Empty title="没有指定订单" /> : <Cashier orderId={orderId} />}
      </LoginCard>
    </PageShell>
  );
}

type Phase =
  { kind: 'idle' } | { kind: 'paying' } | { kind: 'notice'; text: string; retry: boolean };

function Cashier({ orderId }: { orderId: string }) {
  const api = useApiClient();
  const signedIn = useSignedIn();
  const order = useRouteQuery('order.detail', { params: { id: orderId } }, { enabled: signedIn });
  // Back from elsewhere (订单详情, the chat with the shop, WeChat's sheet): the merchant may
  // have changed the price (改价) or the order may have closed meanwhile.
  useRefetchOnShow(routeQueryKey('order.detail', { params: { id: orderId } }), { when: 'always' });
  // Found closed (its coupon and seat given back) or paid elsewhere: 我的订单, the 我的 counts
  // and the 拼团 pages cached before still say 待付款.
  const invalidate = useInvalidateRoutes();
  const queryClient = useQueryClient();
  const settled = order.data !== undefined && order.data.status !== 'pending_payment';
  useEffect(() => {
    if (!settled) return;
    markStale(queryClient, ...DECOR_PAGE_READS);
    void invalidate(...CANCEL_READS);
  }, [settled, invalidate, queryClient]);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [expired, setExpired] = useState(false);
  // Back to 订单详情 when that is where 去支付 was tapped, rather than a second copy of it.
  const toOrder = () => leaveFor({ route: 'order', params: { id: orderId } });

  if (order.isPending) return <CellSkeleton rows={3} />;
  if (order.isError) return <ErrorBlock error={order.error} onRetry={() => order.refetch()} />;

  const detail = order.data;
  if (detail.status !== 'pending_payment' || expired) {
    // The countdown ran out, but the server's answer wins: an order paid in its last second is
    // paid, not closed.
    const cancelled = detail.status === 'pending_payment' ? expired : detail.status === 'cancelled';
    return (
      <Result
        id="cashier-closed"
        status={cancelled ? 'fail' : 'success'}
        title={cancelled ? '订单已关闭' : '订单已支付'}
        description={cancelled ? '超时未支付的订单会自动取消，可以重新下单' : undefined}
        actions={
          <>
            <Button variant="outline" onClick={toOrder}>
              查看订单
            </Button>
            <Button onClick={() => navigate({ route: 'home', params: {} })}>继续购物</Button>
          </>
        }
      />
    );
  }

  async function pay() {
    setPhase({ kind: 'paying' });
    try {
      const intent = await api.call('payment.start', {
        params: { id: orderId },
        body: { channel: 'wechat_mini' },
      });
      const result = {
        route: 'payResult',
        params: { orderId, outTradeNo: intent.outTradeNo },
      } as const;
      if (intent.alreadyPaid) return void (await navigate(result, { replace: true }));
      if (!intent.jsapi) throw new Error('暂时无法发起支付，请稍后再试');
      const outcome = await platform.requestPayment({
        outTradeNo: intent.outTradeNo,
        params: intent.jsapi,
      });
      if (outcome.kind === 'cancelled') {
        setPhase({ kind: 'notice', text: '已取消支付，订单会为你保留一段时间', retry: false });
        return;
      }
      if (outcome.kind === 'failed') {
        // WeChat's sheet is not the answer: the server may have been told it was paid.
        const status = await api
          .call('payment.status', { params: { outTradeNo: intent.outTradeNo } })
          .catch(() => null);
        if (!status?.paid) {
          // The platform already words it for the shopper (「支付没有完成，…」).
          setPhase({ kind: 'notice', text: outcome.message, retry: true });
          return;
        }
      }
      await navigate(result, { replace: true });
    } catch (error) {
      if (isApiError(error) && error.code === 'PAYMENT_ORDER_EXPIRED') {
        setExpired(true);
        return;
      }
      if (isApiError(error) && error.code === 'PAYMENT_ORDER_ALREADY_PAID') {
        void order.refetch();
        setPhase({ kind: 'idle' });
        return;
      }
      if (isApiError(error) && error.code === 'PAYMENT_ORDER_NOT_PAYABLE') {
        // Closed, paid or changed on the server: the order as it is now decides what this page
        // shows (订单已关闭 / 已支付), not a 重新支付 that can only meet the same answer.
        const fresh = await order.refetch();
        setPhase(
          fresh.data?.status === 'pending_payment'
            ? { kind: 'notice', text: error.message, retry: false }
            : { kind: 'idle' },
        );
        return;
      }
      setPhase({
        kind: 'notice',
        text: errorMessage(error, '暂时无法发起支付，请稍后再试'),
        retry: true,
      });
    }
  }

  const first = detail.items[0];
  const retry = phase.kind === 'notice' && phase.retry;
  return (
    <View className="cashier">
      <Card className="cashier__amount-card">
        <Text className="cashier__label">实付金额</Text>
        <View id="cashier-amount">
          <Price value={detail.payableAmount} size="lg" tone="text" className="cashier__amount" />
        </View>
        {detail.payExpiresAt ? (
          <View className="cashier__deadline">
            <Text className="cashier__deadline-label">支付剩余时间</Text>
            <Countdown
              endsAt={detail.payExpiresAt}
              onEnd={() => {
                setExpired(true);
                return order.refetch();
              }}
            />
          </View>
        ) : null}
      </Card>
      <Card className="cashier__card" padded={false}>
        <Pressable label="查看订单详情" role="link" className="cashier__summary" onClick={toOrder}>
          <Text className="cashier__summary-name">
            {first ? first.productName : '订单商品'}
            {detail.items.length > 1 ? ` 等 ${detail.totalQuantity} 件` : ''}
          </Text>
          <Text className="cashier__summary-no">订单编号 {detail.orderNo}</Text>
          <Icon name="chevron-right" className="cashier__summary-arrow" />
        </Pressable>
      </Card>
      <Card className="cashier__card" title="支付方式">
        <View className="cashier__method" ariaRole="radio" ariaChecked ariaLabel="微信支付">
          <Icon name="wallet" className="cashier__method-icon" />
          <Text className="cashier__method-name">微信支付</Text>
          <Icon name="check" className="cashier__method-check" />
        </View>
      </Card>
      {phase.kind === 'notice' ? (
        <Text className="cashier__notice" id="cashier-notice">
          {phase.text}
        </Text>
      ) : null}
      <View className="cashier__bar">
        <Button size="lg" block loading={phase.kind === 'paying'} onClick={() => pay()}>
          {retry ? '重新支付' : '微信支付'}
        </Button>
      </View>
    </View>
  );
}
