import { z } from 'zod';

import { blockProps } from '../base';
import { DECOR_LIMITS } from '../constants';
import { ui } from '../meta';
import { defineBlock } from '../registry';
import { need, personalNeed } from '../sources';

/**
 * 新人券: the coupons a new account is given.
 *
 * 新人券 (`claimMode: new_user`) are granted when the account is created and
 * are never claimable by hand, so the block does not offer a 领取 per coupon.
 * Who sees it:
 *
 * - **A guest** sees the active 新人券 templates (public, cached page data)
 *   and one button, 注册领取, which is the `claimNewcomerCoupons` intent: the
 *   host runs its sign-in, which registers the shopper and grants the coupons,
 *   then reloads the page.
 * - **A signed-in shopper** sees the 新人券 they still hold unused (per
 *   shopper, never cached — DECOR-015) with 去使用. Once they are spent or
 *   expired, or for an account that never got any, the block is hidden.
 *
 * `visibility.audience` still applies on top: `guest` keeps it to guests only.
 */
export const newcomerCouponProps = blockProps({
  title: z
    .string()
    .trim()
    .min(1, '请填写标题')
    .max(10)
    .default('新人专享')
    .meta(ui({ label: '标题', group: '内容' })),
  subtitle: z
    .string()
    .max(20)
    .default('注册即得，下单立减')
    .meta(ui({ label: '副标题（留空不显示）', group: '内容' })),
  limit: z
    .number()
    .int()
    .min(1)
    .max(DECOR_LIMITS.records)
    .default(3)
    .meta(ui({ label: '最多显示几张券', group: '内容' })),
});
export type NewcomerCouponProps = z.infer<typeof newcomerCouponProps>;

export const newcomerCouponBlock = defineBlock({
  type: 'newcomerCoupon',
  v: 1,
  props: newcomerCouponProps,
  meta: { label: '新人券', pages: ['home', 'custom', 'user_center'] },
  data: (props) => ({ coupons: need.newUserCoupons(props.limit) }),
  personal: (props) => ({ held: personalNeed.newcomerCoupons(props.limit) }),
});
