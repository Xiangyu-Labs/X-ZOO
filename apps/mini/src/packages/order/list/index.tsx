import { useState } from 'react';
import { View } from '@tarojs/components';
import type { StorefrontOrderListItem } from '@shop/contracts/order/schemas';
import { routeKey, useInfiniteRouteQuery, useRouteQuery } from '@shop/api-client/react';
import { LIST_FULL_RELOAD_AFTER_MS, useRefetchOnShow } from '@/data/use-refetch-on-show';
import { navigate, scrollPageToTop, useRouteParams } from '@/platform';
import { LoginCard } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { Empty } from '@/ui/empty';
import { InfiniteList } from '@/ui/infinite-list';
import { OrderCard } from '@/ui/order-card';
import { PageShell } from '@/ui/page-shell';
import { CellSkeleton } from '@/ui/skeleton';
import { Tabs } from '@/ui/tabs';
import { useOrderActions } from '../shared/actions';
import { EMPTY_TEXT, ORDER_TABS, tabOf, type ShownTab } from '../shared/tabs';
import './index.scss';

/**
 * 我的订单 (`orderList`, `packages/order/list/index?tab=`). Tabs with the counts of what waits
 * on the shopper, a paged list per tab, and each card's buttons from `orderActions`.
 * Never shared: no share handler (the menu's 转发 is off for this page).
 */
export default function OrderListPage() {
  const params = useRouteParams('orderList');
  const [tab, setTab] = useState<ShownTab>(() => tabOf(params.tab));
  return (
    <PageShell title="我的订单">
      <LoginCard reason="登录后查看订单" redirect={{ route: 'orderList', params: { tab } }}>
        <OrderTabs
          tab={tab}
          onChange={(next) => {
            setTab(next);
            scrollPageToTop();
          }}
        />
        <OrderList key={tab} tab={tab} />
      </LoginCard>
    </PageShell>
  );
}

function OrderTabs({ tab, onChange }: { tab: ShownTab; onChange: (tab: ShownTab) => void }) {
  const signedIn = useSignedIn();
  const counts = useRouteQuery('order.counts', undefined, { enabled: signedIn });
  useRefetchOnShow(routeKey('order.counts'));
  return (
    <Tabs
      sticky
      scrollable
      value={tab}
      onChange={onChange}
      items={ORDER_TABS.map((item) => ({
        key: item.key,
        label: item.label,
        count: item.counted ? counts.data?.[item.key] : undefined,
      }))}
    />
  );
}

function OrderList({ tab }: { tab: ShownTab }) {
  const signedIn = useSignedIn();
  const list = useInfiniteRouteQuery(
    'order.list',
    { query: { tab, pageSize: 10 } },
    { enabled: signedIn },
  );
  useRefetchOnShow(routeKey('order.list'), {
    pages: 'first',
    allPagesAfter: LIST_FULL_RELOAD_AFTER_MS,
  });
  const actions = useOrderActions();

  return (
    <View className="order-list">
      <InfiniteList<StorefrontOrderListItem>
        query={list}
        itemKey={(order) => order.id}
        renderItem={(order) => (
          <OrderCard
            order={order}
            onAction={(key) => actions.run(key, order)}
            busy={actions.busy?.orderId === order.id ? actions.busy.key : undefined}
            onExpire={() => list.refetch()}
          />
        )}
        skeleton={
          <>
            <CellSkeleton rows={3} />
            <CellSkeleton rows={3} />
          </>
        }
        empty={
          <Empty
            image="order"
            title={EMPTY_TEXT[tab]}
            actions={
              <Button
                variant="outline-primary"
                size="md"
                onClick={() => navigate({ route: 'home', params: {} })}
              >
                回到首页
              </Button>
            }
          />
        }
      />
    </View>
  );
}
