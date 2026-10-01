import { useState } from 'react';
import { View } from '@tarojs/components';
import { useInfiniteRouteQuery } from '@shop/api-client/react';
import { useQuickAdd } from '@/features/cart/quick-add';
import { scrollPageToTop, useRouteParams, useShare } from '@/platform';
import { Empty } from '@/ui/empty';
import { InfiniteList } from '@/ui/infinite-list';
import { PageShell } from '@/ui/page-shell';
import { ProductCard } from '@/ui/product-card';
import { ProductCardSkeleton } from '@/ui/skeleton';
import { Tabs } from '@/ui/tabs';
import './index.scss';

type FeaturedTab = 'hot' | 'new' | 'best' | 'benefit';

const FEATURED_TABS: ReadonlyArray<{ key: FeaturedTab; label: string }> = [
  { key: 'best', label: '精品推荐' },
  { key: 'hot', label: '热卖榜' },
  { key: 'new', label: '新品首发' },
  { key: 'benefit', label: '优惠好物' },
];

const isTab = (value: string | undefined): value is FeaturedTab =>
  FEATURED_TABS.some((tab) => tab.key === value);

/**
 * 精品推荐 (`featured { tab? }`, pages.md §2.2): the old 热卖 / 新品 / 精品 / 促销 entries as one
 * page with tabs; `tab` picks the first one. Each tab is `catalog.productList { feature }`.
 */
export default function Featured() {
  const params = useRouteParams('featured');
  const [tab, setTab] = useState<FeaturedTab>(isTab(params.tab) ? params.tab : 'best');
  const quick = useQuickAdd({ route: 'featured', params: { tab } });
  const products = useInfiniteRouteQuery('catalog.productList', {
    query: {
      feature: tab,
      pageSize: 20,
      ...(tab === 'hot' ? { sortBy: 'sales', sortOrder: 'desc' } : {}),
      ...(tab === 'new' ? { sortBy: 'createdAt', sortOrder: 'desc' } : {}),
    },
  });
  const label = FEATURED_TABS.find((item) => item.key === tab)?.label ?? '精品推荐';
  useShare({ route: 'featured', params: { tab } }, { title: label });

  return (
    <PageShell title="精品推荐">
      <Tabs
        sticky
        items={FEATURED_TABS}
        value={tab}
        onChange={(next) => {
          setTab(next);
          scrollPageToTop();
        }}
      />
      <View className="goods-featured__body">
        <InfiniteList
          key={tab}
          query={products}
          columns={2}
          itemKey={(product) => product.id}
          renderItem={(product) => (
            <ProductCard
              product={product}
              onAddToCart={product.canAddToCart ? () => quick.add(product) : undefined}
            />
          )}
          empty={<Empty compact image="search" title="这里还没有商品" description="去看看别的吧" />}
          skeleton={
            <View className="goods-featured__skeleton">
              {[0, 1, 2, 3].map((index) => (
                <ProductCardSkeleton key={index} />
              ))}
            </View>
          }
        />
      </View>
      {quick.sheet}
    </PageShell>
  );
}
