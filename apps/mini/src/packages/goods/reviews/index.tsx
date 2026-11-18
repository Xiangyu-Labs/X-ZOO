import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import { useInfiniteRouteQuery, useRouteQuery } from '@shop/api-client/react';
import { ReviewItem } from '@/features/product/review-item';
import { useRouteParams } from '@/platform';
import { Empty } from '@/ui/empty';
import { InfiniteList } from '@/ui/infinite-list';
import { PageShell } from '@/ui/page-shell';
import { Skeleton } from '@/ui/skeleton';
import { Tabs } from '@/ui/tabs';
import './index.scss';

type Rating = 'all' | 'images';

/**
 * 商品评价 (`productReviews { productId }`, pages.md §2.2): the score, 全部 / 有图 with their
 * counts, then the reviews; pictures open in `previewImage`.
 */
export default function ProductReviews() {
  const { productId = '' } = useRouteParams('productReviews');
  const [rating, setRating] = useState<Rating>('all');
  const summary = useRouteQuery(
    'catalog.productReviewSummary',
    { params: { id: productId } },
    { enabled: productId !== '' },
  );
  const reviews = useInfiniteRouteQuery(
    'catalog.productReviews',
    { params: { id: productId }, query: { rating, pageSize: 20 } },
    { enabled: productId !== '' },
  );

  if (productId === '') {
    return (
      <PageShell title="商品评价">
        <Empty title="没有指定商品" />
      </PageShell>
    );
  }

  const s = summary.data;
  const tabs: ReadonlyArray<{ key: Rating; label: string; count?: number }> = [
    { key: 'all', label: '全部', ...(s ? { count: s.total } : {}) },
    { key: 'images', label: '有图', ...(s ? { count: s.withImagesCount } : {}) },
  ];

  return (
    <PageShell title="商品评价">
      <View className="goods-reviews__summary">
        {s ? (
          <View className="goods-reviews__score">
            <Text className="goods-reviews__score-value">{s.averageScore.toFixed(1)}</Text>
            <Text className="goods-reviews__score-label">综合评分</Text>
          </View>
        ) : (
          <Skeleton className="goods-reviews__summary-skeleton" />
        )}
      </View>
      <Tabs sticky scrollable items={tabs} value={rating} onChange={setRating} />
      <View className="goods-reviews__list">
        <InfiniteList
          key={rating}
          query={reviews}
          itemKey={(review) => review.id}
          renderItem={(review) => (
            <View className="goods-reviews__item">
              <ReviewItem review={review} />
            </View>
          )}
          empty={
            <Empty
              compact
              image="general"
              title={rating === 'all' ? '还没有人评价' : '这一栏还没有评价'}
            />
          }
          skeleton={
            <View className="goods-reviews__item">
              <Skeleton className="goods-reviews__item-skeleton" />
            </View>
          }
        />
      </View>
    </PageShell>
  );
}
