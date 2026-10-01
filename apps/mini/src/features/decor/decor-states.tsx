import { View } from '@tarojs/components';
import { Skeleton, ProductCardSkeleton } from '@/ui/skeleton';
import './decor-page.scss';

/** What a DIY page shows before it arrives: a banner, an icon row, two product cards. */
export function DecorSkeleton() {
  return (
    <View className="decor-skeleton" id="decor-skeleton">
      <Skeleton className="decor-skeleton__banner" />
      <View className="decor-skeleton__row">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} round className="decor-skeleton__icon" />
        ))}
      </View>
      <View className="decor-skeleton__grid">
        <ProductCardSkeleton />
        <ProductCardSkeleton />
      </View>
    </View>
  );
}
