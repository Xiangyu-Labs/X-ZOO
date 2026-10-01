import type { ReactNode } from 'react';
import { Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import './tag.scss';

export interface TagProps {
  tone?: 'primary' | 'warning' | 'success' | 'neutral' | 'danger' | undefined;
  variant?: 'soft' | 'outline' | 'solid' | undefined;
  size?: 'sm' | 'md' | undefined;
  className?: string | undefined;
  children: ReactNode;
}

/** A short label: 「包邮」, 「拼团」, 「待付款」 (design.md §4.1). */
export function Tag({
  tone = 'primary',
  variant = 'soft',
  size = 'sm',
  className,
  children,
}: TagProps) {
  return (
    <View
      className={cx(
        'shop-tag',
        `shop-tag--${tone}`,
        `shop-tag--${variant}`,
        `shop-tag--${size}`,
        className,
      )}
    >
      <Text className="shop-tag__text">{children}</Text>
    </View>
  );
}

export interface BadgeProps {
  /** A number; 0 hides it. Leave out for a dot. */
  count?: number | undefined;
  max?: number | undefined;
  /** Shown over a corner of `children` (an icon); without children it stands inline. */
  children?: ReactNode;
  className?: string | undefined;
}

/** A count bubble (99+) or a dot (design.md §4.1). The count is announced with the icon. */
export function Badge({ count, max = 99, children, className }: BadgeProps) {
  const dot = count === undefined;
  const hidden = !dot && count <= 0;
  const text = dot ? '' : count > max ? `${max}+` : String(count);
  const bubble = hidden ? null : (
    <Text
      className={cx(
        'shop-badge',
        dot && 'shop-badge--dot',
        children !== undefined && 'shop-badge--corner',
      )}
      ariaLabel={dot ? '有新消息' : `${text} 条`}
    >
      {text}
    </Text>
  );
  if (children === undefined) return bubble;
  return (
    <View className={cx('shop-badge-host', className)}>
      {children}
      {bubble}
    </View>
  );
}

/** A hairline, optionally with words in the middle: 「没有更多了」. */
export function Divider({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <View className={cx('shop-divider', children !== undefined && 'shop-divider--text', className)}>
      {children !== undefined ? <Text className="shop-divider__text">{children}</Text> : null}
    </View>
  );
}
