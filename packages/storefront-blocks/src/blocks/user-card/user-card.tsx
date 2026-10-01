import { Image, Text, View } from '@tarojs/components';

import type { UserCardProps } from '@shop/contracts/decor/all-blocks';
import type { LinkTarget } from '@shop/contracts/decor/link';
import { BlockImage } from '../shared/block-image';
import { cx, tapProps } from '../shared/css';
import { BlockFrame } from '../shared/frame';
import { ICONS } from '../shared/icons';
import { userSummaryIn, type PersonalSlots } from '../shared/personal';
import type { BlockProps } from '../shared/types';
import styles from './user-card.module.scss';

const route = (to: 'profile' | 'myCoupons' | 'favorites' | 'history'): LinkTarget => ({
  kind: 'route',
  to: { route: to, params: {} },
});

/**
 * 用户卡片: the signed-in shopper's avatar and name (tap → 个人资料) and,
 * with `showStats`, their coupon / favourite / history totals. A guest (no
 * `personal`) sees a sign-in prompt, which asks the host for `login`. A
 * shopper still on the sign-up nickname or avatar sees one line of small print
 * asking them to set it: never a dialog, and gone once they have.
 */
export function UserCard({
  props,
  personal,
  onLink,
  onIntent,
  host,
}: BlockProps<UserCardProps, undefined, PersonalSlots>) {
  const user = userSummaryIn(personal);
  const stats = user?.stats ?? null;
  const tapIdentity = user
    ? onLink && (() => onLink(route('profile')))
    : onIntent && (() => onIntent({ kind: 'login' }));
  const counters = [
    { label: '优惠券', value: stats?.coupons, link: route('myCoupons') },
    { label: '收藏', value: stats?.favorites, link: route('favorites') },
    { label: '足迹', value: stats?.history, link: route('history') },
  ];
  return (
    <BlockFrame
      type="userCard"
      frame={props.style}
      className={cx(styles.body, props.background && styles.pictured)}
    >
      {props.background ? (
        <BlockImage
          className={styles.background}
          src={props.background}
          width={960}
          resolve={host?.resolveImage}
          mode="aspectFill"
        />
      ) : null}
      <View className={styles.identity} {...tapProps(tapIdentity || undefined)}>
        {user?.avatarUrl ? (
          // A stored `/uploads/…` avatar loads only through the host (the shop's origin).
          <BlockImage
            className={styles.avatar}
            src={user.avatarUrl}
            width={480}
            resolve={host?.resolveImage}
            mode="aspectFill"
          />
        ) : (
          <Image className={styles.avatar} src={ICONS.avatar} mode="aspectFill" />
        )}
        <View className={styles.names}>
          <Text className={styles.name}>{user ? user.nickname || '微信用户' : '登录 / 注册'}</Text>
          {user ? null : <Text className={styles.hint}>登录后查看订单和优惠券</Text>}
          {user?.profileIncomplete ? <Text className={styles.hint}>点击设置头像和昵称</Text> : null}
        </View>
      </View>
      {props.showStats ? (
        <View className={styles.stats}>
          {counters.map((counter) => (
            <View
              key={counter.label}
              className={styles.stat}
              {...tapProps(onLink ? () => onLink(counter.link) : undefined)}
            >
              <Text className={styles.value}>{user ? String(counter.value ?? 0) : '-'}</Text>
              <Text className={styles.statLabel}>{counter.label}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </BlockFrame>
  );
}
