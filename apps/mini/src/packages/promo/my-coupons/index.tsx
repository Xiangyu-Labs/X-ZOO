import { useState } from 'react';
import { View } from '@tarojs/components';
import { routeKey, useInfiniteRouteQuery } from '@shop/api-client/react';
import { LIST_FULL_RELOAD_AFTER_MS, useRefetchOnShow } from '@/data/use-refetch-on-show';
import { walletCardState, type WalletTab } from '@/features/coupon/claim-state';
import { navigate, useRouteParams } from '@/platform';
import { LoginCard } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { CouponCard, couponValidity } from '@/ui/coupon-card';
import { Empty } from '@/ui/empty';
import { InfiniteList } from '@/ui/infinite-list';
import { PageShell } from '@/ui/page-shell';
import { Skeleton } from '@/ui/skeleton';
import { Tabs } from '@/ui/tabs';
import './index.scss';

const TABS: ReadonlyArray<{ key: WalletTab; label: string }> = [
  { key: 'unused', label: '可使用' },
  { key: 'used', label: '已使用' },
  { key: 'expired', label: '已过期' },
];

const EMPTY: Record<WalletTab, string> = {
  unused: '暂无可用的优惠券',
  used: '还没有用过优惠券',
  expired: '没有过期的优惠券',
};

const isTab = (value: string | undefined): value is WalletTab =>
  value === 'unused' || value === 'used' || value === 'expired';

/**
 * 我的优惠券 (`myCoupons { state? }`, pages.md §2.5): 可使用 / 已使用 / 已过期. 去使用 opens the
 * product list for the coupon (`productList { couponId }`: the coupon's **template** id, never
 * the wallet row's `id`), which lists the products it covers. Needs a session.
 */
export default function MyCouponsPage() {
  const { state } = useRouteParams('myCoupons');
  const [tab, setTab] = useState<WalletTab>(isTab(state) ? state : 'unused');
  return (
    <PageShell title="我的优惠券">
      <LoginCard reason="登录后查看你的优惠券" redirect={{ route: 'myCoupons', params: {} }}>
        <Tabs items={TABS} value={tab} onChange={setTab} sticky />
        <Wallet key={tab} tab={tab} />
      </LoginCard>
    </PageShell>
  );
}

function Wallet({ tab }: { tab: WalletTab }) {
  const signedIn = useSignedIn();
  const list = useInfiniteRouteQuery(
    'coupon.myList',
    { query: { state: tab, pageSize: 20 } },
    { enabled: signedIn },
  );
  // Coupons expire, or are used or given back by an order, while the shopper is elsewhere.
  useRefetchOnShow(routeKey('coupon.myList'), {
    pages: 'first',
    allPagesAfter: LIST_FULL_RELOAD_AFTER_MS,
  });
  return (
    <View className="my-coupons" id={`my-coupons-${tab}`}>
      <InfiniteList
        query={list}
        itemKey={(coupon) => coupon.id}
        className="my-coupons__list"
        renderItem={(coupon) => (
          <CouponCard
            title={coupon.title}
            amount={coupon.discountAmount}
            minSpend={coupon.minSpend}
            scope={coupon.scope}
            validity={couponValidity(coupon)}
            state={walletCardState(tab)}
            onAction={
              tab === 'unused'
                ? () =>
                    void navigate({
                      route: 'productList',
                      params: { couponId: coupon.templateId },
                    })
                : undefined
            }
          />
        )}
        skeleton={
          <View className="my-coupons__skeleton">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="my-coupons__skeleton-card" />
            ))}
          </View>
        }
        empty={
          <Empty
            image="coupon"
            title={EMPTY[tab]}
            actions={
              tab === 'unused' ? (
                <Button
                  variant="outline"
                  onClick={() => navigate({ route: 'couponCenter', params: {} })}
                >
                  去领券中心
                </Button>
              ) : undefined
            }
          />
        }
      />
    </View>
  );
}
