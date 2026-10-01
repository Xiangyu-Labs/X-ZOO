import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Text, View } from '@tarojs/components';
import { useInvalidateRoutes, useRouteQuery } from '@shop/api-client/react';
import { DECOR_PAGE_READS, markStale } from '@/data/stale-reads';
import { leaveFor, navigate, useRouteParams } from '@/platform';
import { LoginCard } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { Empty } from '@/ui/empty';
import { PageShell } from '@/ui/page-shell';
import { ProductCard } from '@/ui/product-card';
import { Result } from '@/ui/result';
import './index.scss';

/** How often and for how long 支付结果 asks before it says 确认中 and offers a refresh. */
export const POLL_INTERVAL_MS = 1000;
export const POLL_LIMIT_MS = 60_000;

/**
 * 支付结果 (`payResult { orderId, outTradeNo }`). What `wx.requestPayment` said is not the
 * answer; `payment.status` is, once WeChat's notification reached the server (C06). Polls every
 * second for up to a minute. Paid: 查看订单 and 继续购物 (a group buy: 邀请好友参团). A failed or
 * closed attempt: 重新支付. Still unknown after a minute: 刷新. 为你推荐 below.
 */
export default function PayResultPage() {
  const { orderId = '', outTradeNo = '' } = useRouteParams('payResult');
  return (
    <PageShell title="支付结果">
      <LoginCard
        reason="登录后查看支付结果"
        redirect={{ route: 'payResult', params: { orderId, outTradeNo } }}
      >
        {outTradeNo === '' ? (
          <Empty title="没有支付单号" />
        ) : (
          <PaymentStatus orderId={orderId} outTradeNo={outTradeNo} />
        )}
      </LoginCard>
      <Recommended />
    </PageShell>
  );
}

function PaymentStatus({ orderId, outTradeNo }: { orderId: string; outTradeNo: string }) {
  const signedIn = useSignedIn();
  const [round, setRound] = useState(0);
  const [gaveUp, setGaveUp] = useState(false);
  const status = useRouteQuery(
    'payment.status',
    { params: { outTradeNo } },
    {
      enabled: signedIn,
      refetchInterval: (query) => {
        const data = query.state.data;
        if (gaveUp || data?.paid || data?.status === 'failed' || data?.status === 'closed') {
          return false;
        }
        return POLL_INTERVAL_MS;
      },
    },
  );
  useEffect(() => {
    const timer = setTimeout(() => setGaveUp(true), POLL_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [round]);

  const id = orderId || status.data?.orderId || '';
  const paid = status.data?.paid === true;
  // Every order read cached before the payment (订单详情 under 收银台, 我的订单, the 我的 counts
  // and the decorated pages' 订单入口) still says 待付款, a 拼团 still shows the seat as open and
  // a 预售 its old deposit count: drop them once the server says paid.
  const invalidate = useInvalidateRoutes();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (paid) {
      markStale(queryClient, ...DECOR_PAGE_READS);
      void invalidate(
        'order.detail',
        'order.list',
        'order.counts',
        'groupbuy.detail',
        'groupbuy.groupDetail',
        'groupbuy.myGroups',
        'presale.detail',
      );
    }
  }, [paid, invalidate, queryClient]);
  const order = useRouteQuery(
    'order.detail',
    { params: { id } },
    { enabled: signedIn && paid && id !== '' },
  );

  // Back to 订单详情 when 收银台 was opened from it (支付结果 replaced 收银台), rather than a
  // second copy of the same order on the stack.
  const toOrder = () =>
    leaveFor(id ? { route: 'order', params: { id } } : { route: 'order', params: { outTradeNo } });
  const orderButton = (
    <Button variant="outline" onClick={toOrder}>
      查看订单
    </Button>
  );

  if (paid) {
    const groupbuy = order.data?.kind === 'groupbuy';
    return (
      <Result
        id="pay-result"
        status="success"
        title="支付成功"
        description={
          order.data ? (
            <Text>
              实付 ¥{order.data.paidAmount ?? order.data.payableAmount}
              {groupbuy ? '，邀请好友参团，成团后尽快发货' : '，我们会尽快为你隐私包装发货'}
            </Text>
          ) : undefined
        }
        actions={
          <>
            {orderButton}
            {groupbuy ? (
              <Button
                onClick={() =>
                  // Instead of 支付结果, not over it: Back from the team must not come back here.
                  leaveFor(
                    order.data?.groupbuyTeamId
                      ? { route: 'groupbuyTeam', params: { id: order.data.groupbuyTeamId } }
                      : { route: 'myGroupbuys', params: {} },
                  )
                }
              >
                邀请好友参团
              </Button>
            ) : (
              <Button onClick={() => navigate({ route: 'home', params: {} })}>继续购物</Button>
            )}
          </>
        }
      />
    );
  }
  if (status.data?.status === 'failed' || status.data?.status === 'closed') {
    return (
      <Result
        id="pay-result"
        status="fail"
        title="支付未完成"
        description="这笔支付没有成功，款项不会被扣除"
        actions={
          <>
            {orderButton}
            {id ? (
              <Button
                onClick={() =>
                  navigate({ route: 'cashier', params: { orderId: id } }, { replace: true })
                }
              >
                重新支付
              </Button>
            ) : null}
          </>
        }
      />
    );
  }
  if (gaveUp || status.isError) {
    return (
      <Result
        id="pay-result"
        status="waiting"
        title="支付确认中"
        description="微信支付的结果还没有到达，如已付款请稍后在订单中查看"
        actions={
          <>
            {orderButton}
            <Button
              onClick={() => {
                setGaveUp(false);
                setRound(round + 1);
                return status.refetch();
              }}
            >
              刷新
            </Button>
          </>
        }
      />
    );
  }
  return (
    <Result
      id="pay-result"
      status="pending"
      title="支付确认中"
      description="正在确认支付结果，请稍候"
    />
  );
}

function Recommended() {
  const list = useRouteQuery(
    'catalog.productList',
    { query: { feature: 'recommended', pageSize: 6 } },
    { staleTime: 5 * 60_000 },
  );
  const items = list.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <View className="pay-result__recommend" id="pay-result-recommended">
      <Text className="pay-result__recommend-title">为你推荐</Text>
      <View className="pay-result__grid">
        {items.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </View>
    </View>
  );
}
