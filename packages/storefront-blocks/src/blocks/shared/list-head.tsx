import { Text, View } from '@tarojs/components';

import type { LinkTarget } from '@shop/contracts/decor/link';
import { tapProps } from './css';
import styles from './list-head.module.scss';

export interface ListHeadProps {
  title: string;
  /** Where 「更多」 goes; no link, no 「更多」. */
  more?: LinkTarget | undefined;
  onLink?: ((target: LinkTarget) => void) | undefined;
}

/** The heading row of a marketing list (优惠券, 拼团, 预售, 资讯). Nothing when there is no title and no 「更多」. */
export function ListHead({ title, more, onLink }: ListHeadProps) {
  if (!title && !more) return null;
  return (
    <View className={styles.head}>
      <Text className={styles.title}>{title}</Text>
      {more ? (
        <View className={styles.more} {...tapProps(onLink ? () => onLink(more) : undefined)}>
          <Text>更多</Text>
          <View className={styles.chevron} />
        </View>
      ) : null}
    </View>
  );
}

/** A `route` link with no params: the list pages 「更多」 opens. */
export function routeLink(
  route: 'couponCenter' | 'groupbuyList' | 'presaleList' | 'myCoupons',
): LinkTarget {
  return { kind: 'route', to: { route, params: {} } };
}
