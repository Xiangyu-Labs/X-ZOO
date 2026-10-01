import { Text, View } from '@tarojs/components';

import type { OrderEntryProps } from '@shop/contracts/decor/all-blocks';
import type { OrderEntryKey } from '@shop/contracts/decor/constants';
import type { LinkTarget } from '@shop/contracts/decor/link';
import { BlockImage } from '../shared/block-image';
import { tapProps } from '../shared/css';
import { BlockFrame } from '../shared/frame';
import { ICONS } from '../shared/icons';
import { badgeText, orderCountsIn, type PersonalSlots } from '../shared/personal';
import type { BlockProps } from '../shared/types';
import styles from './order-entry.module.scss';

/** What each entry opens (`ORDER_ENTRY_KEYS`). */
export function orderEntryLink(key: OrderEntryKey): LinkTarget {
  switch (key) {
    case 'unpaid':
    case 'unshipped':
    case 'unreceived':
    case 'unreviewed':
      return { kind: 'route', to: { route: 'orderList', params: { tab: key } } };
    case 'aftersale':
      return { kind: 'route', to: { route: 'refundList', params: {} } };
  }
}

/**
 * 订单入口: 我的订单 with 全部订单, and a row of status entries, each with the
 * signed-in shopper's count as a badge (from `personal`; none for a guest).
 * A custom icon loads through the host's `resolveImage` (its 480 px copy where
 * one exists); the built-in ones are inline data and load as they are.
 */
export function OrderEntry({
  props,
  personal,
  onLink,
  host,
}: BlockProps<OrderEntryProps, undefined, PersonalSlots>) {
  const counts = orderCountsIn(personal);
  const all: LinkTarget = { kind: 'route', to: { route: 'orderList', params: {} } };
  return (
    <BlockFrame type="orderEntry" frame={props.style} className={styles.body}>
      <View className={styles.head}>
        <Text className={styles.title}>{props.title}</Text>
        <View className={styles.all} {...tapProps(onLink ? () => onLink(all) : undefined)}>
          <Text>全部订单</Text>
          <View className={styles.chevron} />
        </View>
      </View>
      <View className={styles.entries}>
        {props.items.map((item) => {
          const badge = badgeText(counts?.[item.key]);
          return (
            <View
              key={item.key}
              className={styles.entry}
              {...tapProps(onLink ? () => onLink(orderEntryLink(item.key)) : undefined)}
            >
              <View className={styles.iconBox}>
                <BlockImage
                  className={styles.icon}
                  src={item.icon ?? ICONS[item.key]}
                  width={480}
                  resolve={item.icon ? host?.resolveImage : undefined}
                  mode="aspectFit"
                />
                {badge ? <Text className={styles.badge}>{badge}</Text> : null}
              </View>
              <Text className={styles.label}>{item.label}</Text>
            </View>
          );
        })}
      </View>
    </BlockFrame>
  );
}
