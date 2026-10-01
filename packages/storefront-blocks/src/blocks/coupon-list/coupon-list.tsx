import { ScrollView, Text, View } from '@tarojs/components';

import type { CouponListProps } from '@shop/contracts/decor/all-blocks';
import type { CouponSummary, CouponUserState } from '@shop/contracts/decor/sources';
import { cx, tapProps } from '../shared/css';
import { BlockFrame } from '../shared/frame';
import { ListHead, routeLink } from '../shared/list-head';
import { couponCondition, shortMoney } from '../shared/money';
import { couponStatesIn, type PersonalSlots } from '../shared/personal';
import { formatMonthDay } from '../shared/time';
import type { BlockProps } from '../shared/types';
import styles from './coupon-list.module.scss';

export interface CouponListData {
  coupons?: readonly CouponSummary[] | null | undefined;
}

/** 05.01-05.31 有效, or 领取后 30 天内有效. */
export function couponValidity(coupon: CouponSummary): string {
  if (coupon.validityMode === 'days_after_claim' && coupon.validDays !== null) {
    return `领取后 ${coupon.validDays} 天内有效`;
  }
  if (coupon.validFrom && coupon.validTo) {
    return `${formatMonthDay(coupon.validFrom)}-${formatMonthDay(coupon.validTo)} 有效`;
  }
  return coupon.validTo ? `${formatMonthDay(coupon.validTo)} 前有效` : '';
}

type Action = 'claim' | 'again' | 'use' | 'gone';

/**
 * What the button offers, from the shopper's own state. Without it (a guest,
 * or a lookup that failed) every coupon offers 领取; the host signs a guest in
 * before claiming, and the server has the last word either way.
 */
export function couponAction(state: CouponUserState | undefined): Action {
  if (!state) return 'claim';
  if (state.canClaim) return state.claimedCount > 0 ? 'again' : 'claim';
  return state.claimedCount > 0 ? 'use' : 'gone';
}

const ACTION_TEXT: Record<Action, string> = {
  claim: '领取',
  again: '再领一张',
  use: '去使用',
  gone: '已抢光',
};

/**
 * 优惠券: claimable coupon tickets, in a sideways row or stacked.
 *
 * The amount, the threshold and the validity come from the cached page data;
 * whether this shopper has one already comes from `personal` (never cached,
 * DECOR-015). 领取 asks the host for `claimCoupon`; 去使用 opens 我的优惠券.
 * Nothing to show hides the block, except in the editor.
 */
export function CouponList({
  props,
  data,
  personal,
  onLink,
  onIntent,
  host,
}: BlockProps<CouponListProps, CouponListData, PersonalSlots>) {
  const coupons = data?.coupons ?? [];
  if (coupons.length === 0 && !host?.canvas) return null;
  const states = couponStatesIn(personal);
  const tickets = coupons.map((coupon) => {
    const action = couponAction(states.get(coupon.templateId));
    const tap =
      action === 'use'
        ? onLink && (() => onLink(routeLink('myCoupons')))
        : action === 'gone'
          ? undefined
          : onIntent && (() => onIntent({ kind: 'claimCoupon', templateId: coupon.templateId }));
    return (
      <View
        key={coupon.templateId}
        className={cx(styles.ticket, action === 'gone' && styles.spent)}
        data-coupon={coupon.templateId}
        data-action={action}
        {...tapProps(tap || undefined)}
      >
        <View className={styles.amount}>
          <Text className={styles.value}>
            <Text className={styles.currency}>¥</Text>
            {shortMoney(coupon.discountAmount)}
          </Text>
          <Text className={styles.condition}>{couponCondition(coupon.minSpend)}</Text>
        </View>
        <View className={styles.detail}>
          <Text className={styles.name}>{coupon.name}</Text>
          <Text className={styles.validity}>{couponValidity(coupon)}</Text>
        </View>
        <View className={cx(styles.button, action === 'use' && styles.outline)}>
          {ACTION_TEXT[action]}
        </View>
      </View>
    );
  });
  return (
    <BlockFrame type="couponList" frame={props.style} className={styles.body}>
      <ListHead
        title={props.title}
        more={props.showMore ? routeLink('couponCenter') : undefined}
        onLink={onLink}
      />
      {coupons.length === 0 ? (
        <View className={styles.empty}>暂无可领取的优惠券，商城中不显示此组件</View>
      ) : props.layout === 'scroll' && coupons.length > 1 ? (
        <ScrollView className={styles.scroll} scrollX enableFlex>
          <View className={styles.track}>{tickets}</View>
        </ScrollView>
      ) : (
        <View className={styles.stack}>{tickets}</View>
      )}
    </BlockFrame>
  );
}
