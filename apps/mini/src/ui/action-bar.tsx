import type { ReactNode } from 'react';
import { Button as TaroButton, Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { H5_BUTTON_ROLE } from './button';
import { Icon, type IconName } from './icon';
import { Pressable } from './pressable';
import { Badge } from './tag';
import './action-bar.scss';

export interface ActionBarIcon {
  icon: IconName;
  label: string;
  onClick?: (() => void | Promise<unknown>) | undefined;
  badge?: number | undefined;
  /** Filled / coloured (收藏 on). */
  active?: boolean | undefined;
  /** 客服: an `open-type="contact"` button (C15), with its session source. */
  contact?: { sessionFrom: string } | undefined;
}

export interface ActionBarProps {
  /** Left: 客服, 购物车, 收藏… */
  icons?: readonly ActionBarIcon[] | undefined;
  /** Right: one or two `Button`s (they share the space). */
  children?: ReactNode;
  className?: string | undefined;
}

function IconBody({ item }: { item: ActionBarIcon }) {
  const icon = <Icon name={item.icon} className="shop-action-bar__icon" />;
  return (
    <>
      {item.badge ? <Badge count={item.badge}>{icon}</Badge> : icon}
      <Text className="shop-action-bar__label">{item.label}</Text>
    </>
  );
}

/**
 * The fixed bottom bar of detail pages (design.md §1.3): icon entries left, buttons right,
 * 100 high plus the home indicator. The page's `PageShell withBar` leaves room for it.
 */
export function ActionBar({ icons = [], children, className }: ActionBarProps) {
  return (
    <View className={cx('shop-action-bar', className)}>
      {icons.map((item) =>
        item.contact ? (
          <TaroButton
            key={item.label}
            className="shop-action-bar__item shop-action-bar__item--button"
            hoverClass="shop-pressed"
            {...H5_BUTTON_ROLE}
            openType="contact"
            sessionFrom={item.contact.sessionFrom}
            ariaLabel={item.label}
          >
            <IconBody item={item} />
          </TaroButton>
        ) : (
          <Pressable
            key={item.label}
            label={item.badge ? `${item.label}，${item.badge} 件` : item.label}
            selected={item.active}
            className={cx('shop-action-bar__item', item.active && 'shop-action-bar__item--active')}
            onClick={item.onClick}
          >
            <IconBody item={item} />
          </Pressable>
        ),
      )}
      <View className="shop-action-bar__buttons">{children}</View>
    </View>
  );
}
