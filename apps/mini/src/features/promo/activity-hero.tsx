import { View } from '@tarojs/components';
import { Skeleton } from '@/ui/skeleton';
import './activity-hero.scss';

/** What an old 拼团 / 预售 link shows while it reads the activity before opening the product. */
export function ActivitySkeleton() {
  return (
    <View className="activity-hero__skeleton">
      <Skeleton className="activity-hero__skeleton-image" />
      <View className="activity-hero__summary">
        <Skeleton width="40%" />
        <Skeleton width="90%" />
        <Skeleton width="60%" />
      </View>
    </View>
  );
}
