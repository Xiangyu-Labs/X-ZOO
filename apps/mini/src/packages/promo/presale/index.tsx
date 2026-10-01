import { Text, View } from '@tarojs/components';
import { useInfiniteRouteQuery } from '@shop/api-client/react';
import { activityCard, activityPhase, shipText } from '@/features/promo/activity';
import { serverNow } from '@/lib/server-clock';
import { navigate, useShare } from '@/platform';
import { Button } from '@/ui/button';
import { Empty } from '@/ui/empty';
import { InfiniteList } from '@/ui/infinite-list';
import { PageShell } from '@/ui/page-shell';
import { ProductCard } from '@/ui/product-card';
import { ProductCardSkeleton } from '@/ui/skeleton';
import './index.scss';

const ROUTE = { route: 'presaleList', params: {} } as const;

/**
 * 预售 (`presaleList`, pages.md §2.5): the presale activities, each with its presale price and
 * when it ships. A card opens the activity (`presale { id }`).
 *
 * The shop sells presale in full payment only (定金预售 is not supported by the backend), so
 * the page says 「全款预订」 and never mentions a deposit.
 */
export default function PresaleListPage() {
  useShare(ROUTE, { title: '预售' });
  const list = useInfiniteRouteQuery('presale.list', { query: { pageSize: 20 } });

  return (
    <PageShell title="预售">
      <View className="presale-list" id="presale-list">
        <View className="presale-list__intro">
          <Text className="presale-list__rule">全款预订，按约定时间发货</Text>
        </View>
        <InfiniteList
          query={list}
          itemKey={(card) => card.activityId}
          className="presale-list__items"
          renderItem={(card) => {
            const { product, activityPrice } = activityCard(card);
            const phase = activityPhase(card, serverNow());
            return (
              <ProductCard
                product={{ ...product, subtitle: shipText(card.shipAfterDays) }}
                layout="list"
                activity={phase === 'upcoming' ? '即将开始' : '预售'}
                activityPrice={activityPrice}
                onClick={() => navigate({ route: 'presale', params: { id: card.activityId } })}
              />
            );
          }}
          skeleton={[0, 1, 2].map((key) => (
            <ProductCardSkeleton key={key} layout="list" />
          ))}
          empty={
            <Empty
              image="cart"
              title="暂时没有预售活动"
              actions={
                <Button variant="outline" onClick={() => navigate({ route: 'home', params: {} })}>
                  回到首页
                </Button>
              }
            />
          }
        />
      </View>
    </PageShell>
  );
}
