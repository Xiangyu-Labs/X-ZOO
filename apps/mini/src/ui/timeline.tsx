import type { ReactNode } from 'react';
import { Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import './timeline.scss';

export interface TimelineItem {
  key: string;
  /** What happened: 「快件已签收」, 「商家已同意退款」. */
  title: ReactNode;
  /** When, already formatted. */
  time?: string | undefined;
  /** A second line: the courier's words, a remark. */
  description?: ReactNode;
}

export interface TimelineProps {
  /** Newest first: the first item is the current step and is the one highlighted. */
  items: readonly TimelineItem[];
  className?: string | undefined;
}

/**
 * A vertical list of what happened, newest on top (物流轨迹, 售后进度; design.md §4.1). The top
 * dot is filled in the primary colour, the rest are grey; a line joins them.
 */
export function Timeline({ items, className }: TimelineProps) {
  return (
    <View className={cx('shop-timeline', className)} ariaRole="list">
      {items.map((item, index) => (
        <View
          key={item.key}
          ariaRole="listitem"
          className={cx('shop-timeline__item', index === 0 && 'shop-timeline__item--current')}
        >
          <View className="shop-timeline__rail">
            <View className="shop-timeline__dot" />
            {index < items.length - 1 ? <View className="shop-timeline__line" /> : null}
          </View>
          <View className="shop-timeline__body">
            <Text className="shop-timeline__title">{item.title}</Text>
            {item.description !== undefined && item.description !== null ? (
              <Text className="shop-timeline__description">{item.description}</Text>
            ) : null}
            {item.time ? <Text className="shop-timeline__time">{item.time}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  );
}
