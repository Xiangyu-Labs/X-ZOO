import { z } from 'zod';

import { blockProps } from '../base';
import { COUPON_LIST_LAYOUTS, type CouponListLayout } from '../constants';
import { ui } from '../meta';
import { defineBlock } from '../registry';
import { couponSource, need } from '../sources';
import { listHeading } from './list-heading';

/**
 * 优惠券: coupon tickets a shopper can claim by hand, picked by id or 「全部可领」
 * (the first `limit` the coupon centre shows).
 *
 * The page data is the templates, the same for everybody and cached. Whether
 * *this* shopper has claimed one, or may claim another, is per-shopper state:
 * the resolver adds it in `personal` only with a session, never cached
 * (DECOR-015). A tap on 领取 is an intent (`claimCoupon`); the block calls no
 * API — the host signs a guest in first, then claims, then refreshes the page.
 */
export const couponListProps = blockProps({
  ...listHeading('领券中心'),
  source: couponSource
    .default({ mode: 'auto', limit: 3 })
    .meta(ui({ label: '优惠券来源', field: 'couponSource', group: '内容' })),
  layout: z
    .enum(Object.keys(COUPON_LIST_LAYOUTS) as [CouponListLayout, ...CouponListLayout[]])
    .default('scroll')
    .meta(ui({ label: '排列方式', field: 'radio', options: COUPON_LIST_LAYOUTS, group: '展示' })),
});
export type CouponListProps = z.infer<typeof couponListProps>;

export const couponListBlock = defineBlock({
  type: 'couponList',
  v: 1,
  props: couponListProps,
  meta: { label: '优惠券', pages: ['home', 'custom', 'user_center'] },
  data: (props) => ({ coupons: need.coupons(props.source) }),
});
