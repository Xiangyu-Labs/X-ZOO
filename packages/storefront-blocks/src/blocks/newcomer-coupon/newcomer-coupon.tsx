import { Text, View } from '@tarojs/components';

import type { NewcomerCouponProps } from '@shop/contracts/decor/all-blocks';
import type { CouponSummary } from '@shop/contracts/decor/sources';
import { tapProps } from '../shared/css';
import { BlockFrame } from '../shared/frame';
import { routeLink } from '../shared/list-head';
import { couponCondition, shortMoney } from '../shared/money';
import { heldCouponsIn, type PersonalSlots } from '../shared/personal';
import { formatMonthDay } from '../shared/time';
import type { BlockProps } from '../shared/types';
import styles from './newcomer-coupon.module.scss';

export interface NewcomerCouponData {
  coupons?: readonly CouponSummary[] | null | undefined;
}

interface Chip {
  key: string;
  amount: string;
  condition: string;
  note?: string | undefined;
}

/**
 * 新人券.
 *
 * - A guest sees the 新人券 on offer and 注册领取, which asks the host for
 *   `claimNewcomerCoupons` (sign-in registers the account, and registration
 *   grants them).
 * - A signed-in shopper sees the 新人券 they still hold, with 去使用 (我的优惠券).
 *   Holding none — spent, expired, or an account that predates them — hides
 *   the block, as does a lookup that failed: it never shows a signed-in
 *   shopper an offer they cannot take.
 *
 * Guest or not is `host.signedIn`, not the presence of the slot.
 */
export function NewcomerCoupon({
  props,
  data,
  personal,
  onLink,
  onIntent,
  host,
}: BlockProps<NewcomerCouponProps, NewcomerCouponData, PersonalSlots>) {
  const signedIn = host?.signedIn === true && !host.canvas;
  let chips: Chip[];
  let title = props.title;
  let subtitle = props.subtitle;
  let action: { text: string; tap: (() => void) | undefined };
  if (signedIn) {
    const held = heldCouponsIn(personal);
    if (!held || held.length === 0) return null;
    chips = held.slice(0, props.limit).map((coupon) => ({
      key: coupon.id,
      amount: shortMoney(coupon.discountAmount),
      condition: couponCondition(coupon.minSpend),
      note: `${formatMonthDay(coupon.validTo)} 到期`,
    }));
    title = '新人券已到账';
    subtitle = `${held.length} 张新人券待使用`;
    action = { text: '去使用', tap: onLink && (() => onLink(routeLink('myCoupons'))) };
  } else {
    const offered = (data?.coupons ?? []).slice(0, props.limit);
    if (offered.length === 0 && !host?.canvas) return null;
    chips = offered.map((coupon) => ({
      key: coupon.templateId,
      amount: shortMoney(coupon.discountAmount),
      condition: couponCondition(coupon.minSpend),
    }));
    action = {
      text: '注册领取',
      tap: onIntent && (() => onIntent({ kind: 'claimNewcomerCoupons' })),
    };
  }
  return (
    <BlockFrame type="newcomerCoupon" frame={props.style} className={styles.body}>
      <View className={styles.panel} data-state={signedIn ? 'held' : 'offer'}>
        <View className={styles.head}>
          <View className={styles.titles}>
            <Text className={styles.title}>{title}</Text>
            {subtitle ? <Text className={styles.subtitle}>{subtitle}</Text> : null}
          </View>
          <View className={styles.button} {...tapProps(action.tap)}>
            {action.text}
          </View>
        </View>
        {chips.length === 0 ? (
          <View className={styles.empty}>暂无新人券，商城中不显示此组件</View>
        ) : (
          <View className={styles.chips}>
            {chips.map((chip) => (
              <View key={chip.key} className={styles.chip}>
                <Text className={styles.amount}>
                  <Text className={styles.currency}>¥</Text>
                  {chip.amount}
                </Text>
                <Text className={styles.condition}>{chip.condition}</Text>
                {chip.note ? <Text className={styles.note}>{chip.note}</Text> : null}
              </View>
            ))}
          </View>
        )}
      </View>
    </BlockFrame>
  );
}
