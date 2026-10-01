import { View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import './skeleton.scss';

/** Skeleton shimmer; the app config can switch it off (design.md §6, reduced motion). */
let animated = true;
export function setSkeletonAnimation(on: boolean): void {
  animated = on;
}

export interface SkeletonProps {
  width?: string | undefined;
  height?: string | undefined;
  round?: boolean | undefined;
  className?: string | undefined;
}

/** A grey block standing in for content that is loading. Hidden from screen readers. */
export function Skeleton({ width, height, round, className }: SkeletonProps) {
  return (
    <View
      ariaHidden
      className={cx(
        'shop-skeleton',
        animated && 'shop-skeleton--animated',
        round && 'shop-skeleton--round',
        className,
      )}
      style={{ ...(width ? { width } : {}), ...(height ? { height } : {}) }}
    />
  );
}

/** A product card's shape, grid or list. */
export function ProductCardSkeleton({ layout = 'grid' }: { layout?: 'grid' | 'list' }) {
  return (
    <View className={cx('shop-skeleton-card', `shop-skeleton-card--${layout}`)} ariaHidden>
      <Skeleton className="shop-skeleton-card__image" />
      <View className="shop-skeleton-card__body">
        <Skeleton className="shop-skeleton__line" />
        <Skeleton className="shop-skeleton__line shop-skeleton__line--short" />
        <Skeleton className="shop-skeleton__line shop-skeleton__line--price" />
      </View>
    </View>
  );
}

/** Rows of a cell group. */
export function CellSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <View className="shop-skeleton-cells" ariaHidden>
      {Array.from({ length: rows }, (_, index) => (
        <View key={index} className="shop-skeleton-cells__row">
          <Skeleton className="shop-skeleton__line shop-skeleton__line--short" />
        </View>
      ))}
    </View>
  );
}
