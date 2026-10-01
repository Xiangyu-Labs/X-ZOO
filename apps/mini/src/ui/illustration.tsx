import { View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import './illustration.scss';

export type IllustrationName =
  'general' | 'search' | 'order' | 'network' | 'cart' | 'coupon' | 'building';

/** A decorative empty-state drawing in the shop's colours (hidden from screen readers). */
export function Illustration({ name, small }: { name: IllustrationName; small?: boolean }) {
  return (
    <View className={cx('shop-art', `shop-art--${name}`, small && 'shop-art--sm')} ariaHidden>
      <View className="shop-art__layer shop-art__layer--fill" />
      <View className="shop-art__layer shop-art__layer--line" />
      <View className="shop-art__layer shop-art__layer--accent" />
    </View>
  );
}
