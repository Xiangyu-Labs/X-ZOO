import type { ReactNode } from 'react';
import { Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { Icon, type IconName } from './icon';
import './result.scss';

export type ResultStatus = 'success' | 'pending' | 'fail' | 'waiting';

const ICONS: Record<ResultStatus, IconName> = {
  success: 'success',
  pending: 'clock',
  fail: 'warning',
  waiting: 'info',
};

export interface ResultProps {
  status: ResultStatus;
  title: string;
  description?: ReactNode;
  /** Primary, then secondary `Button`s, stacked. */
  actions?: ReactNode;
  /** Below the buttons: a recommendation rail, an order summary. */
  children?: ReactNode;
  className?: string | undefined;
  id?: string | undefined;
}

/**
 * The result layout (design.md §5 E): icon, title, explanation, buttons. `pending` is the honest
 * 「确认中」 while the server has not heard from WeChat yet (C06).
 */
export function Result({
  status,
  title,
  description,
  actions,
  children,
  className,
  id,
}: ResultProps) {
  return (
    <View
      {...(id ? { id } : {})}
      className={cx('shop-result', `shop-result--${status}`, className)}
    >
      <View className="shop-result__icon">
        <Icon name={ICONS[status]} />
      </View>
      <Text className="shop-result__title" ariaRole="heading">
        {title}
      </Text>
      {description ? <View className="shop-result__description">{description}</View> : null}
      {actions ? <View className="shop-result__actions">{actions}</View> : null}
      {children}
    </View>
  );
}
