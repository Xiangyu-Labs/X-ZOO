import type { ReactNode } from 'react';
import { Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { Icon, type IconName } from './icon';
import { Pressable } from './pressable';
import './cell.scss';

export interface CellProps {
  title: ReactNode;
  /** A line under the title. */
  description?: ReactNode;
  /** The value on the right (text, a `Switch`, a `Badge`). */
  value?: ReactNode;
  icon?: IconName | undefined;
  /** The red star before the title (a required form row). */
  required?: boolean | undefined;
  /** Shows the chevron and makes the row tappable. */
  onClick?: (() => void | Promise<unknown>) | undefined;
  /** Chevron without a tap handler of our own (the row wraps a native picker). */
  arrow?: boolean | undefined;
  disabled?: boolean | undefined;
  /** A validation message under the row, in red text (never colour alone, §7). */
  error?: string | undefined;
  /** What a screen reader says for a tappable row; defaults to the title when it is text. */
  label?: string | undefined;
  /** Top-align the title with a multi-line value (an address). */
  alignTop?: boolean | undefined;
  className?: string | undefined;
  children?: ReactNode;
}

/**
 * A row: icon, title (and description), value and chevron, ≥ 96 high, hairline below
 * (design.md §4.3). Tappable rows take the pressed tint and are announced as links.
 */
export function Cell({
  title,
  description,
  value,
  icon,
  required,
  onClick,
  arrow,
  disabled,
  error,
  label,
  alignTop,
  className,
  children,
}: CellProps) {
  const showArrow = arrow ?? onClick !== undefined;
  const body = (
    <>
      <View className={cx('shop-cell__row', alignTop && 'shop-cell__row--top')}>
        {icon ? <Icon name={icon} className="shop-cell__icon" /> : null}
        <View className="shop-cell__main">
          <View className="shop-cell__title">
            {required ? (
              <Text className="shop-cell__required" ariaHidden>
                *
              </Text>
            ) : null}
            {title}
          </View>
          {description ? <View className="shop-cell__description">{description}</View> : null}
        </View>
        {value !== undefined && value !== null ? (
          <View className="shop-cell__value">{value}</View>
        ) : null}
        {showArrow ? <Icon name="chevron-right" className="shop-cell__arrow" /> : null}
      </View>
      {children}
      {error ? <Text className="shop-cell__error">{error}</Text> : null}
    </>
  );
  const classes = cx('shop-cell', disabled && 'shop-cell--disabled', className);
  if (!onClick) return <View className={classes}>{body}</View>;
  return (
    <Pressable
      className={classes}
      role="link"
      label={label ?? (typeof title === 'string' ? title : '')}
      disabled={disabled}
      onClick={onClick}
    >
      {body}
    </Pressable>
  );
}

export interface CellGroupProps {
  /** A caption above the group, on the grey. */
  title?: string | undefined;
  /** Cards on the page (inset, rounded) or edge to edge (settings, forms). */
  inset?: boolean | undefined;
  className?: string | undefined;
  children?: ReactNode;
}

/** A white group of cells; groups sit 20 apart (design.md §5 D). */
export function CellGroup({ title, inset = true, className, children }: CellGroupProps) {
  return (
    <View className={cx('shop-cell-group', inset && 'shop-cell-group--inset', className)}>
      {title ? <Text className="shop-cell-group__title">{title}</Text> : null}
      <View className="shop-cell-group__body">{children}</View>
    </View>
  );
}
