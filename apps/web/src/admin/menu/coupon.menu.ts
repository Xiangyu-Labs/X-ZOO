import { defineMenu } from './types';

/**
 * 营销 → 优惠券.
 *
 * One file per domain, aggregated by `pnpm gen` into the gitignored
 * `menu.gen.ts`, so adding a domain touches no shared index.
 *
 * `permission` here only decides what the sider shows; the server checks the
 * atom declared on each route again. The two lists must agree, which is why
 * both come from `couponPermissions` in `@shop/core/coupon/permissions.ts`.
 */
export default defineMenu({
  key: 'coupon',
  label: '优惠券',
  icon: 'TagsOutlined',
  order: 300,
  children: [
    {
      key: 'coupon.templates',
      label: '优惠券列表',
      path: '/admin/coupon/templates',
      permission: 'coupon:template:read',
      order: 10,
    },
    {
      key: 'coupon.userCoupons',
      label: '已领取记录',
      path: '/admin/coupon/user-coupons',
      permission: 'coupon:user-coupon:read',
      order: 20,
    },
  ],
});
