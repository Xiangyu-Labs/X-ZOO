import { defineMenu } from './types';

/**
 * 营销 → 拼团.
 *
 * Three entries: 拼团商品 / 拼团列表 / 拼团统计. The paths say `groupbuy`, not
 * `combination`: that segment would be a transliteration of nothing and the URL is what an operator's history shows.
 *
 * `permission` here only decides what the sider shows; the server checks the
 * atom declared on each route again. Both lists come from `groupbuyPermissions`
 * in `@shop/core/groupbuy/permissions.ts`.
 */
export default defineMenu({
  key: 'groupbuy',
  label: '拼团',
  icon: 'UsergroupAddOutlined',
  order: 310,
  children: [
    {
      key: 'groupbuy.activities',
      label: '拼团活动',
      path: '/admin/groupbuy/activities',
      permission: 'groupbuy:activity:read',
      order: 10,
    },
    {
      key: 'groupbuy.groups',
      label: '拼团列表',
      path: '/admin/groupbuy/groups',
      permission: 'groupbuy:group:read',
      order: 20,
    },
    {
      key: 'groupbuy.statistics',
      label: '拼团统计',
      path: '/admin/groupbuy/statistics',
      permission: 'groupbuy:activity:read',
      order: 30,
    },
  ],
});
