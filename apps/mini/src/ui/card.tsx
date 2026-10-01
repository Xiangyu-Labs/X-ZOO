import type { ReactNode } from 'react';
import { Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import './card.scss';

export interface CardProps {
  /** A heading row; `extra` sits at its right (a link, a count). */
  title?: string | undefined;
  extra?: ReactNode;
  /** Inner padding; off for cards whose content brings its own (a cell group, a list). */
  padded?: boolean | undefined;
  className?: string | undefined;
  id?: string | undefined;
  children?: ReactNode;
}

/** A white card on the grey page (WeUI 灰底白卡, design.md §1.2): 702 wide, radius md. */
export function Card({ title, extra, padded = true, className, id, children }: CardProps) {
  return (
    <View
      {...(id ? { id } : {})}
      className={cx('shop-card', padded && 'shop-card--padded', className)}
    >
      {title ? (
        <View className="shop-card__header">
          <Text className="shop-card__title">{title}</Text>
          {extra ? <View className="shop-card__extra">{extra}</View> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}
