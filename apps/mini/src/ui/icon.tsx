import { View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { px } from '@/platform';
import './icon.scss';

/** Every icon in the set (`icon.scss`); keep the two lists in step. */
export const ICON_NAMES = [
  'home',
  'category',
  'cart',
  'user',
  'search',
  'chevron-right',
  'chevron-left',
  'chevron-down',
  'chevron-up',
  'close',
  'check',
  'plus',
  'minus',
  'heart',
  'heart-fill',
  'star',
  'star-fill',
  'service',
  'share',
  'download',
  'location',
  'clock',
  'coupon',
  'truck',
  'wallet',
  'package',
  'refund',
  'trash',
  'camera',
  'copy',
  'bell',
  'info',
  'warning',
  'success',
  'edit',
  'more',
  'arrow-up',
  'gift',
  'order',
  'image',
  'image-plus',
  'list',
  'grid',
  'message',
  'group',
  'filter',
  'phone',
  'settings',
  'close-circle',
  'dot',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

export interface IconProps {
  name: IconName;
  /** Design px (750 wide). Without it the icon is 1em: it follows the text around it. */
  size?: number;
  className?: string;
  /**
   * What a screen reader says. Without a label the icon is decoration and hidden from the
   * accessibility tree (docs/mini/design.md §7).
   */
  label?: string;
}

/** A line icon in `currentColor`. */
export function Icon({ name, size, className, label }: IconProps) {
  const dimension = size === undefined ? undefined : px(size);
  return (
    <View
      className={cx('shop-icon', `shop-icon--${name}`, className)}
      {...(dimension ? { style: { width: dimension, height: dimension } } : {})}
      {...(label ? { ariaRole: 'img', ariaLabel: label } : { ariaHidden: true })}
    />
  );
}
