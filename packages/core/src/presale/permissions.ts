import { definePermissions } from '../auth/permissions';

/**
 * Presale permission atoms.
 *
 * `order:read` is separate from `activity:read` because the two screens answer
 * to different people: 预售活动 is 运营's, 预售订单 is 客服's, and an assistant
 * who may look at what shoppers ordered has no business editing the price they
 * ordered at.
 *
 * The atom string is `presale:<resource>:<action>`; `definePermissions` adds the
 * domain prefix, so the keys here omit it.
 */
export const presalePermissions = definePermissions(
  'presale',
  {
    'activity:read': '查看预售活动',
    'activity:write': '新建/编辑预售活动',
    'activity:delete': '删除预售活动',
    'order:read': '查看预售订单',
  },
  { section: '营销' },
);
