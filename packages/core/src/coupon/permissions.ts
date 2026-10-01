import { definePermissions } from '../auth/permissions';

/**
 * Coupon permission atoms.
 *
 * Five atoms, not fifteen. The split follows what an operator's job actually
 * is: someone who designs campaigns (`template:*`), someone who hands coupons
 * to a complaining customer (`grant:write`), and someone in support who needs
 * to see what a customer holds (`user-coupon:read`). `delete` is separate from
 * `write` because deleting a template hides every coupon issued from it.
 *
 * The atom string is `coupon:<resource>:<action>`; `definePermissions` adds the
 * domain prefix, so the keys here omit it.
 */
export const couponPermissions = definePermissions(
  'coupon',
  {
    'template:read': '查看优惠券',
    'template:write': '新建/编辑优惠券',
    'template:delete': '删除优惠券',
    'grant:write': '发放优惠券给用户',
    'user-coupon:read': '查看已领取的优惠券',
  },
  { section: '营销' },
);
