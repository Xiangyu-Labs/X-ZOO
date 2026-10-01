import type { ReactNode } from 'react';
import type { CouponScope } from '@shop/contracts/coupon/schemas';
import { Text, View } from '@tarojs/components';
import { cx } from '@/lib/cx';
import { formatDate } from '@/lib/format';
import { splitMoney } from './price';
import { Pressable } from './pressable';
import './coupon-card.scss';

/**
 * Every state a coupon is shown in (design.md §4.4): on 领券中心 (`claimable`, `claimed`,
 * `sold-out`), in the checkout picker (`usable`, `unusable`), and in the wallet (`usable`,
 * `used`, `expired`).
 */
export type CouponCardState =
  'claimable' | 'claimed' | 'sold-out' | 'usable' | 'unusable' | 'used' | 'expired';

export interface CouponCardProps {
  title: string;
  /** Money off (`discountAmount`). */
  amount: string;
  /** `"0.00"` is 无门槛. */
  minSpend: string;
  scope: CouponScope;
  /** From `couponValidity(...)`. */
  validity: string;
  state: CouponCardState;
  /** Checkout picker: this one is chosen. */
  selected?: boolean | undefined;
  /** `unusable`: why (the server's reason, already in words). */
  reason?: string | undefined;
  /** The button on the right (领取 / 去使用); the picker makes the whole card the control. */
  onAction?: (() => void | Promise<unknown>) | undefined;
  /** The action is in flight (领取中). */
  busy?: boolean | undefined;
  className?: string | undefined;
}

const SCOPE: Record<CouponScope, string> = {
  all_products: '全场通用',
  categories: '指定分类可用',
  products: '指定商品可用',
};

/** 「2026.09.01 - 2026.09.30」 or 「领取后 7 天内有效」. */
export function couponValidity(coupon: {
  validFrom: string | null;
  validTo: string | null;
  validDays?: number | null | undefined;
}): string {
  if (coupon.validFrom && coupon.validTo) {
    return `${formatDate(coupon.validFrom)} - ${formatDate(coupon.validTo)}`;
  }
  if (coupon.validDays) return `领取后 ${coupon.validDays} 天内有效`;
  if (coupon.validTo) return `${formatDate(coupon.validTo)} 前有效`;
  return '';
}

/** `"0.00"` → 无门槛; otherwise 满 100 可用. */
export function minSpendText(minSpend: string): string {
  const [whole, fraction] = splitMoney(minSpend);
  if (Number(whole) === 0 && (fraction === '' || fraction === '.00')) return '无门槛';
  return `满 ${whole}${fraction === '.00' ? '' : fraction} 可用`;
}

const ACTION: Partial<Record<CouponCardState, string>> = {
  claimable: '立即领取',
  claimed: '去使用',
  usable: '去使用',
};

const STAMP: Partial<Record<CouponCardState, string>> = {
  'sold-out': '已抢光',
  used: '已使用',
  expired: '已过期',
};

/** A coupon: the amount on the left, terms in the middle, the action or a stamp on the right. */
export function CouponCard({
  title,
  amount,
  minSpend,
  scope,
  validity,
  state,
  selected,
  reason,
  onAction,
  busy,
  className,
}: CouponCardProps) {
  const [whole, fraction] = splitMoney(amount);
  const dim =
    state === 'used' || state === 'expired' || state === 'sold-out' || state === 'unusable';
  const picker = selected !== undefined;
  const stamp = STAMP[state];
  const actionLabel = ACTION[state];

  let right: ReactNode = null;
  if (picker) {
    right = (
      <View className={cx('shop-coupon__pick', selected && 'shop-coupon__pick--on')} ariaHidden />
    );
  } else if (stamp) {
    right = <Text className="shop-coupon__stamp">{stamp}</Text>;
  } else if (actionLabel && onAction) {
    right = (
      <Pressable
        label={`${actionLabel} ${title}`}
        className={cx(
          'shop-coupon__action',
          state === 'claimable' ? 'shop-coupon__action--solid' : 'shop-coupon__action--outline',
          busy && 'shop-coupon__action--busy',
        )}
        disabled={busy}
        onClick={onAction}
      >
        {busy ? '领取中' : actionLabel}
      </Pressable>
    );
  }

  const body = (
    <>
      <View className="shop-coupon__value">
        <View className="shop-coupon__amount">
          <Text className="shop-coupon__yuan">¥</Text>
          <Text className="shop-coupon__whole">{whole}</Text>
          {fraction && fraction !== '.00' ? (
            <Text className="shop-coupon__yuan">{fraction}</Text>
          ) : null}
        </View>
        <Text className="shop-coupon__threshold">{minSpendText(minSpend)}</Text>
      </View>
      <View className="shop-coupon__terms">
        <Text className="shop-coupon__title">{title}</Text>
        <Text className="shop-coupon__scope">{SCOPE[scope]}</Text>
        <Text className="shop-coupon__validity">{validity}</Text>
      </View>
      <View className="shop-coupon__side">{right}</View>
    </>
  );

  return (
    <View
      className={cx(
        'shop-coupon',
        dim && 'shop-coupon--dim',
        selected && 'shop-coupon--selected',
        className,
      )}
    >
      {picker ? (
        <Pressable
          role="radio"
          checked={selected}
          disabled={state === 'unusable'}
          label={`${title}，${minSpendText(minSpend)}，减 ${whole} 元`}
          className="shop-coupon__main"
          pressedTint={false}
          onClick={onAction}
        >
          {body}
        </Pressable>
      ) : (
        <View className="shop-coupon__main">{body}</View>
      )}
      {state === 'unusable' && reason ? (
        <Text className="shop-coupon__reason">{reason}</Text>
      ) : null}
    </View>
  );
}
