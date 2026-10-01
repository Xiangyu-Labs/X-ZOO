import type { ReactNode } from 'react';
import { Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { Illustration, type IllustrationName } from './illustration';
import './empty.scss';

export interface EmptyProps {
  /** Which drawing: `general`, `search`, `order`, `network`, `cart`, `coupon`, `building`. */
  image?: IllustrationName | undefined;
  title: string;
  description?: string | undefined;
  /** The next step (a `Button`, or two). An empty state always offers one where it can. */
  actions?: ReactNode;
  /** Less padding and a smaller drawing, inside a card or a sheet. */
  compact?: boolean | undefined;
}

/** An empty state: drawing, title, a line of help and the next step (design.md §4.2). */
export function Empty({ image = 'general', title, description, actions, compact }: EmptyProps) {
  return (
    <View className={cx('shop-empty', compact && 'shop-empty--compact')}>
      <Illustration name={image} {...(compact ? { small: true } : {})} />
      <Text className="shop-empty__title">{title}</Text>
      {description ? <Text className="shop-empty__description">{description}</Text> : null}
      {actions ? <View className="shop-empty__actions">{actions}</View> : null}
    </View>
  );
}
