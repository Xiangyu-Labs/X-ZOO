import { Text, View } from '@tarojs/components';
import { useInfiniteRouteQuery } from '@shop/api-client/react';
import { formatDateTime } from '@/lib/format';
import { navigate, useShare } from '@/platform';
import { Button } from '@/ui/button';
import { Empty } from '@/ui/empty';
import { InfiniteList } from '@/ui/infinite-list';
import { PageShell } from '@/ui/page-shell';
import { ProductCard } from '@/ui/product-card';
import { ProductCardSkeleton } from '@/ui/skeleton';
import './index.scss';

const ROUTE = { route: 'flashSaleList', params: {} } as const;

/**
 * 限时秒杀 (`flashSaleList`): the products on 秒杀 now, soonest-ending first — where a DIY
 * 限时秒杀 block's 「更多」 goes. A card opens the product, which shows the 秒杀 and sells at
 * its price through ordinary checkout.
 */
export default function FlashSaleListPage() {
  useShare(ROUTE, { title: '限时秒杀' });
  const list = useInfiniteRouteQuery('catalog.flashSaleList', { query: { pageSize: 20 } });

  return (
    <PageShell title="限时秒杀">
      <View className="flash-sale-list" id="flash-sale-list">
        <Text className="flash-sale-list__rule">秒杀价限时有效，结束后恢复原价</Text>
        <InfiniteList
          query={list}
          itemKey={(card) => card.activityId}
          className="flash-sale-list__items"
          renderItem={(card) => (
            <ProductCard
              product={{
                id: card.productId,
                name: card.title,
                subtitle: `${formatDateTime(card.endAt)} 结束`,
                imageUrl: card.imageUrl ?? '',
                cardImageUrl: null,
                price: card.originalPrice ?? card.price,
                originalPrice: null,
                stock: card.stock,
                salesDisplay: 0,
                labels: [],
                canAddToCart: false,
              }}
              layout="list"
              activity={card.canBuy ? '秒杀' : '已抢光'}
              activityPrice={card.originalPrice ? card.price : undefined}
              onClick={() => navigate({ route: 'product', params: { id: card.productId } })}
            />
          )}
          skeleton={[0, 1, 2].map((key) => (
            <ProductCardSkeleton key={key} layout="list" />
          ))}
          empty={
            <Empty
              image="cart"
              title="暂时没有秒杀活动"
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
